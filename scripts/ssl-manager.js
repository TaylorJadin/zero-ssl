function SSLManager(config) {
    /**
     * Implements Let's Encrypt SSL management of the Jelastic environment
     * @param {{
     *      appId  : {String}
     *      envName : {String}
     *      envDomain : {String}
     *      envAppid : {String}
     *      baseUrl : {String}
     *      baseDir : {String}     
     *      scriptName : {String}
     *      cronTime : {String}
     *      email : {String}
     *      [action] : {String}
     *      [session] : {String}
     *      [token] : {String}
     *      [isTask] : {Boolean}
     *      [nodeId] : {Number}
     *      [nodeIp] : {String}
     *      [nodeGroup] : {String}
     *      [customDomains] : {String}
     *      [deployHook] : {String}
     *      [deployHookType] : {String}
     *      [undeployHook] : {String}
     *      [undeployHookType] : {String}
     *      [test] : {Boolean}
     * }} config
     * @constructor
     */

    var Response = com.hivext.api.Response,
        Transport = com.hivext.api.core.utils.Transport,
        StrSubstitutor = org.apache.commons.lang3.text.StrSubstitutor,
        Random = com.hivext.api.utils.Random,
        me = this,
        isValidToken = false,
        patchBuild = 1,
        debug = [],
        nodeManager,
        baseUrl,
        session;

    config = config || {};
    session = config.session || "";

    nodeManager = new NodeManager(config.envName, config.nodeId, config.baseDir);
    nodeManager.setLogPath("var/log/letsencrypt.log");
    nodeManager.setBackupPath("var/lib/jelastic/keys/letsencrypt");

    me.auth = function (token) {
        if (!config.session && String(token).replace(/\s/g, "") != config.token) {
            return {
                result: Response.PERMISSION_DENIED,
                error: "wrong token",
                type:"error",
                message:"Token [" + token + "] does not match",
                response: { result: Response.PERMISSION_DENIED }
            };
        } else {
            isValidToken = true;
        }

        return { result : 0 };
    };

    me.invoke = function (action) {
        var actions = {
            "install"     : me.install,
            "uninstall"   : me.uninstall,
            "auto-update" : me.autoUpdate,
            "backup-scripts": me.backupScripts,
            "restore-scripts": me.restoreScripts
        };
        
        if (getParam("uninstall")) {
            action = "uninstall";
        }
        
        if (!actions[action]) {
            return {
                result : Response.ERROR_UNKNOWN,
                error : "unknown action [" + action + "]"
            }
        }

        return actions[action].call(me);
    };

    me.install = function (isUpdate) {
        var resp = me.exec([
            [ me.installLetsEncrypt ],
            [ me.generateSslConfig ],
            [ me.generateSslCerts ],
            [ me.updateGeneratedCustomDomains ]
        ]);
        
        if (resp.result == 0) {
            me.exec(me.scheduleAutoUpdate);
            resp = me.exec(me.deploy);
        }

        me.exec(me.sendResp, resp, isUpdate);
        me.exec(me.checkSkippedDomainsInSuccess, resp);

        return resp;
    };

    me.checkSkippedDomainsInSuccess = function checkSkippedDomainsInSuccess(resp) {
        var sSkippedDomains = me.getSkippedDomains();

        if (sSkippedDomains) {
            sSkippedDomains = ">**Note:** The Let’s Encrypt SSL was not issued for the following domain names: \n > * " + me.formatDomains(sSkippedDomains, true) + "\n > \n > Fix their DNS records via your domain registrar admin panel, and reinstall/update the add-on or remove them from the [Let's Encrypt](https://jelastic.com/blog/free-ssl-certificates-with-lets-encrypt/) settings.";
        }

        resp.skippedDomains = sSkippedDomains || "";

        return resp;
    };

    me.logAction = function (actionName, resp) {
        var uid = getUserInfo().uid,
            oData = {
                appId: config.appId,
                email: config.email,
                envAppid : config.envAppid,
                envDomain : config.envDomain,
                nodeGroup : config.nodeGroup,
                scriptName : config.scriptName
            },
            oResp;

        if (resp && resp.result == 0) {
            oData.message = "LE add-on has been updated successfully";
        }

        oResp = jelastic.dev.scripting.Eval("appstore", session, "LogAction", {
            uid: uid,
            actionName: actionName,
            response: resp,
            data: oData || {}
        });

        //log("ActionLog: " + oResp);
    };
    
    me.updateGeneratedCustomDomains = function () {
        var setting = "opt/letsencrypt/settings",
            resp;

        resp = nodeManager.cmd([
            "grep -E '^domain=' %(setting) | cut -c 8-",
            "grep -E 'skipped_domains=' %(setting) | cut -c 17-"
        ], {
            setting : nodeManager.getPath(setting)
        });
        
        if (resp.result != 0) return resp;
        
        resp = resp.responses ? resp.responses[0] : resp;
        resp = resp.out.replace(/\'/g, "").split("\n");

        me.setCustomDomains(resp[0]);
        me.setSkippedDomains(resp[1]);

        return {
            result: 0
        };
    };

    me.reinstall = function reinstall(){
        var settings = {},
            resp;

        me.logAction("StartPatchLEAutoUpdate");
        nodeManager.setBackupCSScript();
        resp = me.exec(me.backupScripts);

        if (resp.result != 0) {
            me.logAction("ErrorPatchLEAutoUpdate", resp);
            return resp;
        }

        settings = {
            nodeId              : config.nodeId,
            customDomains       : me.getCustomDomains(),
            nodeGroup           : config.nodeGroup || "",
            deployHook          : config.deployHook || "",
            deployHookType      : config.deployHookType || "",
            undeployHook        : config.undeployHook || "",
            undeployHookType    : config.undeployHookType || ""
        };

        resp = jelastic.marketplace.jps.install({
            appid: appid,
            session: session,
            jps: me.getFileUrl("manifest.jps"),
            envName: me.getEnvName(),
            settings: settings,
            nodeGroup: config.nodeGroup || "",
            writeOutputTasks: false
        });

        me.logAction("EndPatchLEAutoUpdate", resp);

        if (resp.result != 0) {
            me.exec(me.restoreDataIfNeeded);
        }

        return resp;
    };

    me.uninstall = function () {
        var autoUpdateScript = nodeManager.getScriptPath("auto-update-ssl-cert.sh");

        return me.execAll([
            [ me.cmd, "crontab -l 2>/dev/null | grep -v '%(scriptPath)' | crontab -", {
                scriptPath : autoUpdateScript
            }],

            me.undeploy,

            [ me.cmd, 'rm -rf %(paths)', {
                paths : [
                    // "/etc/letsencrypt",
                    nodeManager.getPath("opt/letsencrypt"),
                    nodeManager.getScriptPath("generate-ssl-cert.sh"),
                    nodeManager.getScriptPath("letsencrypt_settings"),
                    nodeManager.getScriptPath("install-le.sh"),
                    nodeManager.getScriptPath("validation.sh"),
                    autoUpdateScript
                ].join(" ")
            }]
        ]);
    };

    me.backupScripts = function backupScripts() {
        var backupPath = nodeManager.getBackupPath(),
            logPath = nodeManager.getLogPath();

        return me.exec([
            [ me.cmd, "mkdir -p %(backupPath)", {
                backupPath: backupPath
            }],

            [ me.cmd, "cd %(letsencryptPath); hash tar 2>/dev/null && echo tar || yum install tar -y; tar -czvf backup.tar . >> %(logPath); mv backup.tar %(backupPath)", {
                logPath: logPath,
                backupPath: backupPath,
                letsencryptPath: nodeManager.getPath("opt/letsencrypt")
            }],

            [ me.cmd, "cat /var/spool/cron/root | grep letsencrypt-ssl > %(backupPath)/letsencrypt-cron", {
                backupPath: backupPath
            }],

            [ me.cmd, "\\cp -r {%(scriptToBackup)} %(backupPath)", {
                backupPath: backupPath,
                scriptToBackup: [
                    nodeManager.getScriptPath("auto-update-ssl-cert.sh"),
                    nodeManager.getScriptPath("install-le.sh"),
                    nodeManager.getScriptPath("validation.sh")
                ].join(",")
            }]
        ])
    };

    me.restoreScripts = function restoreScripts() {
        var backupPath = nodeManager.getBackupPath(),
            logPath = nodeManager.getLogPath();

        return me.execAll([
            [ me.cmd, "cat %(backupPath)/letsencrypt-cron >> /var/spool/cron/root", {
                backupPath: backupPath
            }],

            [ me.cmd, "hash tar 2>/dev/null && echo tar || yum install tar -y; mkdir -p %(settingsPath) && cd %(settingsPath) && tar -xzvf %(backupPath)/backup.tar > %(logPath)", {
                backupPath: backupPath,
                logPath: logPath,
                settingsPath: nodeManager.getPath("opt/letsencrypt"),
            }],

            [ me.cmd, "cp -r %(backupPath)/{%(files)} %(rootPath)", {
                backupPath: backupPath,
                rootPath: nodeManager.getPath("root"),
                files: [
                    "auto-update-ssl-cert.sh",
                    "install-le.sh",
                    "validation.sh"
                ].join(",")
            }]
        ])
    };

    me.restoreCron = function restoreCron() {
        me.logAction("AutoPatchLECronRestore");

        return me.exec(me.cmd, "cat %(backupPath)/letsencrypt-cron >> /var/spool/cron/root", {
            backupPath: nodeManager.getBackupPath()
        });
    },

    me.autoUpdate = function () {
        var resp;

        if (getPlatformVersion() < "4.9.5") {
            return me.exec(me.sendEmail, "Action Required", "html/update-required.html");
        }

        if (!config.isTask) {
            me.logAction("StartUpdateLEFromContainer");
            
            if (!session && me.hasValidToken()) {
                session = signature;
            }

            resp = nodeManager.getEnvInfo();

            if (resp.result == 0) {
                resp = log("checkPermissions");
            }

            if (resp && resp.result != 0) {
                return me.checkEnvAccessAndUpdate(resp);
            }
        }

        if (config.patchVersion == patchBuild) {
            resp = me.install(true);
        } else {
            resp = me.reinstall();
        }

        me.logAction("EndUpdateLEFromContainer", resp);

        return resp;
    };

    me.restoreCSScript = function restoreCSScript() {
        var oResp,
            sCode = nodeManager.getCSScriptCode();

        me.logAction("AutoPatchLEScriptRestore");
        return jelastic.dev.scripting.CreateScript(config.scriptName, "js", sCode);
    };

    me.restoreDataIfNeeded = function () {
        var oResp = getScript(config.scriptName);

        if (oResp.result == Response.SCRIPT_NOT_FOUND) {
            me.logAction("AutoPatchLEAddOnRemoved");

            if (nodeManager.getCSScriptCode()) {
                me.exec([
                    [ me.restoreCSScript ],
                    [ me.restoreScripts ]
                ]);
            }
        }

        return { result : 0 };
    };

    me.checkEnvAccessAndUpdate = function (errResp) {
        var errorMark = "session [xxx"; //mark of error access to a shared env

        if (errResp.result == Response.USER_NOT_AUTHENTICATED && errResp.error.indexOf(errorMark) > -1) {
            //creating new session using Scheduler
            return me.exec(me.addAutoUpdateTask);
        }

        return me.exec(me.sendErrResp, errResp);
    };

    me.addAutoUpdateTask = function addAutoUpdateTask() {
        me.logAction("AddLEAutoUpdateTask");
        
        return jelastic.utils.scheduler.AddTask({
            appid: appid,
            session: session,
            script: config.scriptName,
            trigger: "once_delay:1000",
            description: "update LE sertificate",
            params: { token: config.token, task: 1, action : "auto-update" }
        });
    };

    me.hasValidToken = function () {
        return isValidToken;
    };

    me.creteScriptAndInstall = function createInstallationScript() {
        return me.exec([
            [ me.applyCustomDomains, config.customDomains ],
            [ me.initEntryPoint ],
            [ me.validateEntryPoint ],
            [ me.createScript ],
            [ me.evalScript, "install" ]
        ]);
    };

    me.parseDomains = function (domains) {
        return (domains || "").replace(/^\s+|\s+$/gm , "").split(/\s*[;,\s]\s*/);
    };

    me.applyCustomDomains = function applyCustomDomains(domains) {
        var domainRegex;

        if (domains) {
            domainRegex = /^(.*([.*-]{0,61}[.*])?\.)+[a-zA-Z0-9-]{2,24}(\n|$)/; ///^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9-]{2,24}(\n|$)/;

            domains = me.parseDomains(domains);

            for (var i = domains.length; i--;) {
                if (!domainRegex.test(domains[i])) {
                    return {
                        result: Response.ERROR_UNKNOWN,
                        type: "error",
                        message: "Domain " + domains[i] + " is invalid. Please double check specified domains in the External Domains field."
                    };
                }
            }

            me.setCustomDomains(domains.join(" "));
        }

        return { result : 0 };
    };

    me.setCustomDomains = function (domains) {
        config.customDomains = domains;
    };

    me.getCustomDomains = function () {
        return config.customDomains;
    };
    
    me.setSkippedDomains = function (domains) {
        config.skippedDomains = domains;
    };

    me.getSkippedDomains = function () {
        return config.skippedDomains || "";
    };

    me.formatDomains = function (domains, bList) {

        if (bList) {
            return domains.replace(/ -d /g, '\n > * ');
        }

        return domains ? domains.replace(/ -d/g, ', ') : "";
    };

    me.getEnvName = function () {
        return config.envName || "";
    };

    me.getFileUrl = function (filePath) {
        return config.baseUrl + "/" + filePath + "?_r=" + Math.random();
    };

    me.getScriptUrl = function (scriptName) {
        return me.getFileUrl("scripts/" + scriptName);
    };

    me.initEntryPoint = function initEntryPoint() {
        var group = config.nodeGroup,
            id = config.nodeId,
            nodes,
            resp;

        if (!id && !group) {
            resp = nodeManager.getEntryPointGroup();
            if (resp.result != 0) return resp;

            group = resp.group;
            config.nodeGroup = group;
        }

        resp = nodeManager.getEnvInfo();

        if (resp.result != 0) return resp;
        nodes = resp.nodes;

        for (var j = 0, node; node = nodes[j]; j++) {
            if ((id && node.id != id) ||
                (!id && node.nodeGroup != group)) continue;

            if (!node.extIPs || node.extIPs.length == 0) {
                resp = me.exec.call(nodeManager, nodeManager.attachExtIp, node.id);
                if (resp.result != 0) return resp;
            }

            if (id || node.ismaster) {
                config.nodeId = node.id;
                config.nodeIp = node.address;

                nodeManager.setNodeId(config.nodeId);
                nodeManager.setNodeIp(config.nodeIp);

                if (nodeManager.isExtraLayer(group) && node.url) {
                    nodeManager.setEnvDomain(node.url.replace(/http:\/\//, ''));
                }
            }

            if (id) break;
        }

        return { result : 0 };
    };

    me.validateEntryPoint = function validateEntryPoint() {
        var fileName = "validation.sh",
            url = me.getScriptUrl(fileName);

        var resp = nodeManager.cmd([
            "mkdir -p $(dirname %(path))",
            "mkdir -p $(dirname %(logPath))",
            "wget --no-check-certificate '%(url)' -O '%(path)'",
            "chmod +x %(path) >> %(log)",
            "source %(path)",
            "validateExtIP",
            "validateDNSSettings '%(domain)'"
        ], {
            url : url,
            logPath : nodeManager.getLogPath(),
            path : nodeManager.getScriptPath(fileName),
            domain : config.customDomains || config.envDomain
        });

        if (resp.result == Response.JEM_OPERATION_COULD_NOT_BE_PERFORMED) {
            resp = resp.responses[0];
            var error = resp.out + "\n" + (resp.errOut || resp.error || "");

            resp = {
                result: Response.JEM_OPERATION_COULD_NOT_BE_PERFORMED,
                type: "error",
                error: error,
                response: error,
                message: error
            };
        }

        return resp;
    };

    me.createScript = function createScript() {
        var url = me.getScriptUrl("install-ssl.js"),
            scriptName = config.scriptName,
            scriptBody,
            resp;

        try {
            scriptBody = new Transport().get(url);

            config.token = Random.getPswd(64);
            config.patchVersion = patchBuild;

            scriptBody = me.replaceText(scriptBody, config);

            //delete the script if it already exists
            jelastic.dev.scripting.DeleteScript(scriptName);

            //create a new script
            resp = jelastic.dev.scripting.CreateScript(scriptName, "js", scriptBody);

            java.lang.Thread.sleep(1000);

            //build script to avoid caching
            jelastic.dev.scripting.Build(scriptName);
        } catch (ex) {
            resp = error(Response.ERROR_UNKNOWN, toJSON(ex));
        }

        return resp;
    };

    me.evalScript = function evalScript(action) {
        var params = { token : config.token };

        if (action) params.action = action;

        var resp = jelastic.dev.scripting.Eval(config.scriptName, params);

        if (resp.result == 0 && typeof resp.response === "object" && resp.response.result != 0) {
            resp = resp.response;
        }

        return resp;
    };

    me.installLetsEncrypt = function installLetsEncrypt() {
        var fileName = "install-le.sh",
            url = me.getScriptUrl(fileName);

        return nodeManager.cmd([
            "wget --no-check-certificate '%(url)' -O '%(path)'",
            "chmod +x %(path)",
            "%(path) >> %(log)"
        ], {
            url : url,
            path : nodeManager.getScriptPath(fileName)
        });
    };

    me.generateSslConfig = function generateSslConfig() {
        var path = "opt/letsencrypt/settings",
            primaryDomain = window.location.host,
            envDomain = config.envDomain,
            customDomains = config.customDomains;

        if (customDomains) {
            customDomains = me.parseDomains(customDomains).join(" -d ");
        }

        return nodeManager.cmd('printf "%(params)" > %(path)', {
            params : _([
                "domain='%(domain)'",
                "email='%(email)'",
                "appid='%(appid)'",
                "appdomain='%(appdomain)'",
                "baseDir='%(baseDir)'",
                "test='%(test)'",
                "primarydomain='%(primarydomain)'"
            ].join("\n"), {
                domain: customDomains || envDomain,
                email : config.email || "",
                appid : config.envAppid || "",
                baseDir : config.baseDir,
                appdomain : envDomain || "",
                test : config.test || !customDomains,
                primarydomain: primaryDomain,
                letsEncryptEnv : config.letsEncryptEnv || ""
            }),
            path : nodeManager.getPath(path)
        });
    };

    me.generateSslCerts = function generateSslCerts() {
        var fileName = "generate-ssl-cert.sh",
            url = me.getScriptUrl(fileName),
            validationFileName = "validation.sh",
            generateSSLScript = nodeManager.getScriptPath(fileName),
            bUpload,
            resp;

        me.execAll([
            //download SSL generation script
            [ me.cmd, [
                "wget --no-check-certificate '%(url)' -O %(path)",
                "chmod +x %(path)",
                "wget --no-check-certificate '%(validationUrl)' -O %(validationPath)",
                "chmod +x %(path)"
            ], {
                validationUrl : me.getScriptUrl(validationFileName),
                validationPath : nodeManager.getScriptPath(validationFileName),
                url : url,
                path : generateSSLScript
            }],

            //redirect incoming requests to master node
            [ me.manageDnat, "add" ]
        ]);

        bUpload = nodeManager.checkCustomSSL();

        //execute ssl generation script
        resp = me.analyzeSslResponse(
            me.exec(me.cmd, generateSSLScript + (bUpload ? "" : " --no-upload-certs"))
        );

        //removing redirect
        me.exec(me.manageDnat, "remove");

        return resp;
    };

    me.analyzeSslResponse = function (resp) {
        var out,
            errors;

        if (resp.responses) {
            resp = resp.responses[0];
            out = resp.error + resp.errOut + resp.out;

            //just cutting "out" for debug logging because it's too long in SSL generation output
            resp.out = out.substring(out.length - 400);

            errors = {
                "An unexpected error": "Please see",
                "The following errors": "appid =",
                "Error: ": null
            };

            for (var start in errors) {
                var end = errors[start];
                var ind1 = out.indexOf(start);

                if (ind1 != -1) {
                    var ind2 = end ? out.indexOf(end, ind1) : -1;
                    var message = ind2 == -1 ? out.substring(ind1).replace(start, "") : out.substring(ind1, ind2); //removed duplicated words in popup
                    resp = error(Response.ERROR_UNKNOWN, message);
                    break;
                }
            }
        }

        return resp;
    };

    //managing certificate challenge validation by routing all requests to master node with let's encrypt engine
    me.manageDnat = function manageDnat(action) {
        return nodeManager.cmd(
            "ip a | grep -q  '%(nodeIp)' || { iptables -t nat %(action) PREROUTING -p tcp --dport 80 -j DNAT --to-destination %(nodeIp):80; iptables %(action) FORWARD -p tcp -j ACCEPT;  iptables -t nat %(action) POSTROUTING -d %(nodeIp) -j MASQUERADE; }",
            {
                nodeGroup : config.nodeGroup,
                nodeIp    : config.nodeIp,
                action    : action == 'add' ? '-I' : '-D'
            }
        );
    };

    me.scheduleAutoUpdate = function scheduleAutoUpdate() {
        var fileName = "auto-update-ssl-cert.sh",
            scriptUrl = me.getScriptUrl(fileName),
            autoUpdateUrl;

        autoUpdateUrl = _(
            "https://%(host)/%(scriptName)?appid=%(appid)&token=%(token)&action=auto-update",
            {
                host : window.location.host,
                scriptName : config.scriptName,
                appid : appid,
                token : config.token
            }
        );

        return nodeManager.cmd([
            "wget --no-check-certificate '%(url)' -O %(scriptPath)",
            "chmod +x %(scriptPath)",
            "crontab -l  >/dev/null | grep -v '%(scriptPath)' | crontab -",
            "echo \"%(cronTime) su - root -c \\\"%(scriptPath) '%(autoUpdateUrl)' >> %(log)\\\"\" >> /var/spool/cron/root"
        ], {
            url : scriptUrl,
            cronTime : config.cronTime,
            scriptPath : nodeManager.getScriptPath(fileName),
            autoUpdateUrl : autoUpdateUrl
        });
    };

    me.deploy = function deploy() {
        if (config.deployHook) 
        {
            return me.evalHook(config.deployHook, config.deployHookType);
        }

        if (nodeManager.checkCustomSSL()) {
            return me.exec(me.bindSSL);
        }

        return { result : 0 };
    };

    me.undeploy = function undeploy() {
        if (config.patchVersion != patchBuild || me.isMoreLEAppInstalled()) {
            return { result : 0 };
        }

        if (config.undeployHook) {
            return me.evalHook(config.undeployHook, config.undeployHookType);
        }

        if (nodeManager.checkCustomSSL()) {
            return me.exec(me.removeSSL);
        }

        return { result : 0 };
    };

    me.evalHook = function evalHook(hook, hookType) {
        var urlRegex = new RegExp("^[a-z]+:\\/\\/"),
            hookBody;

        if (urlRegex.test(hook)) {
            try {
                hookBody = new Transport().get(hook);
            } catch (ex) {
                return error(Response.ERROR_UNKNOWN, toJSON(ex));
            }
        } else {
            hookBody = hook;
        }

        if (hookType == "js") {
            return me.exec(me.evalCode, hookBody, config);
        }

        return me.exec(me.cmd, "/bin/bash %(hook) >> %(log)", { hook : hookBody });
    };

    me.evalCode = function evalCode(code, params) {
        var resp = jelastic.dev.scripting.EvalCode(appid, session, code, "js", "", params || {});

        return resp.response || resp
    };

    me.bindSSL = function bindSSL() {
        var cert_key = nodeManager.readFile("/tmp/privkey.url"),
            cert     = nodeManager.readFile("/tmp/cert.url"),
            chain    = nodeManager.readFile("/tmp/fullchain.url"),
            resp;

        if (cert_key.body && chain.body && cert.body) {
            resp = jelastic.env.binder.BindSSL(config.envName, session, cert_key.body, cert.body, chain.body);
        } else {
            resp = error(Response.ERROR_UNKNOWN, "Can't read SSL certificate: key=%(key) cert=%(cert) chain=%(chain)", {
                key   : cert_key,
                cert  : cert,
                chain : chain
            });
        }

        return resp;
    };

    me.removeSSL = function removeSSL() {
        return jelastic.env.binder.RemoveSSL(config.envName, session);
    };

    me.sendResp = function sendResp(resp, isUpdate) {
        var action = isUpdate ? "updated" : "installed",
            sSkippedDomains = me.getSkippedDomains();

        if (resp.result != 0) {
            return me.sendErrResp(resp);
        }

        return me.sendEmail(
            "Successful " + (isUpdate ? "Update" : "Installation"),
            "html/update-success.html", {
                ENVIRONMENT : config.envDomain,
                ACTION : action,
                UPDATED_DOMAINS: "Successfully " + action + " custom domains: <b>" + me.formatUpdatedDomains() + "</b>",
                SKIPPED_DOMAINS: me.getSkippedDomains() ? "<br><br>Please note that Let’s Encrypt cannot assign SSL certificates for the following domain names: <b>" + me.formatDomains(me.getSkippedDomains()) + "</b>.<br>" + "You can fix the issues with DNS records (IP addresses) via your domain admin panel or by removing invalid custom domains from <a href='https://jelastic.com/blog/free-ssl-certificates-with-lets-encrypt/'>Let's Encrypt settings</a>." : ""
            }
        );
    };

    me.formatUpdatedDomains = function formatUpdatedDomains() {
        var sDomains = me.formatDomains(me.getCustomDomains()),
            aDomains = [],
            sDomain,
            sResp = "";

        aDomains = sDomains.split(", ");

        for (var i = 0, n = aDomains.length; i < n; i++) {
            sDomain = aDomains[i];
            sResp += "<a href=\"https://" + sDomain + "/\">" + sDomain + "</a>";

            sResp = (n > i + 1) ? sResp += ", " : sResp;
        }

        return sResp || "";
    };
    
    me.isMoreLEAppInstalled = function isMoreLEAppInstalled () {
        var resp;

        resp = jelastic.dev.scripting.Eval("appstore", session, "GetApps", {
            targetAppid: config.envAppid,
            search: {"appstore":"1","app_id":"letsencrypt-ssl-addon", "nodeGroup": {"!=":config.nodeGroup}}
        });

        if (resp.result != 0) return resp;

        resp = resp.response;
        return !!(resp.apps && resp.apps.length);
    };

    me.sendErrResp = function sendErrResp(resp) {
        resp = resp || {};

        if (!me.getCustomDomains() && me.getSkippedDomains()) {
            resp = "Please note that the SSL certificates cannot be assigned to the available custom domains due to incorrect DNS settings.\n\n" +
                "You can fix the issues with DNS records (IP addresses) via your domain admin panel or by removing invalid custom domains from Let's Encrypt settings.\n\n" +
                "In case you no longer require SSL certificates within <b>" + config.envDomain + "</b> environment, feel free to delete Let’s Encrypt add-on to stop receiving error messages.";
        } else {
            resp.debug = debug;
        }

        return me.sendEmail("Error", "html/update-error.html", {
            SUPPORT_EMAIL : "support@jelastic.com",
            RESP : resp || ""
        });
    };

    me.getEmailTitle = function (title) {
        return title + ": Let's Encrypt SSL at " + config.envDomain;
    };

    me.sendEmail = function (title, filePath, values) {
        var email = config.email,
            resp,
            html;

        try {
            html = new Transport().get(me.getFileUrl(filePath));

            if (values) {
                html = me.replaceText(html, values);
            }

            resp = jelastic.message.email.Send(appid, session, null, email, email, me.getEmailTitle(title), html);
        } catch (ex) {
            resp = error(Response.ERROR_UNKNOWN, toJSON(ex));
        }

        return resp;
    };

    me.exec = function (methods, onFail, bBreakOnError) {
        var resp, fn, args;

        if (!methods.push) {
            methods = [ Array.prototype.slice.call(arguments) ];
            onFail = null;
            bBreakOnError = true;
        }

        for (var i = 0, n = methods.length; i < n; i++) {
            if (!methods[i].push) {
                methods[i] = [ methods[i] ];
            }

            fn = methods[i][0];
            methods[i].shift();

            log(fn.name + (methods[i].length > 0 ?  ": " + methods[i] : ""));

            resp = fn.apply(this, methods[i]);
            debug.push(resp);

            log(fn.name + ".response: " + resp);

            if (resp.result != 0) {
                me.logAction("InstallLE-" + fn.name, resp);
                resp.method = fn.name;
                if (onFail) onFail(resp);
                if (bBreakOnError !== false) break;
            }
        }

        return resp;
    };

    me.execAll = function (methods, onFail) {
        return me.exec(methods, onFail, false);
    };

    me.cmd = function cmd(commands, values, sep) {
        return nodeManager.cmd(commands, values, sep, true);
    };

    me.replaceText = function (text, values) {
        return new StrSubstitutor(values, "${", "}").replace(text);
    };

    function NodeManager(envName, nodeId, baseDir, logPath) {
        var me = this,
            BL = "bl",
            LB = "lb",
            CP = "cp",
            bCustomSSLSupported,
            oBackupScript,
            sBackupPath,
            envInfo,
            nodeIp,
            node;

        baseDir = baseDir || "/";

        me.getPath = function (path) {
            return baseDir + (path || "");
        };

        me.getPathByUrl = function (url, path) {
            return me.getPath(path) + me.getFileName(url);
        };

        me.getScriptPath = function (scriptName) {
            return me.getPath("root" + (scriptName ? "/" + scriptName : ""));
        };

        me.getFileName = function (url) {
            return url.match(/.*\/([^?]+).*$/)[1] || url;
        };

        me.setBaseDir = function (path) {
            baseDir = path;
        };

        me.getLogPath = function () {
            return logPath;
        };

        me.setLogPath = function (path) {
            logPath = baseDir + path;
        };

        me.setBackupPath = function (path) {
            sBackupPath = baseDir + path;
        };

        me.getBackupPath = function () {
            return sBackupPath;
        };

        me.setNodeId = function (id) {
            nodeId = id;
        };

        me.setNodeIp = function (ip) {
            nodeIp = ip;
        };

        me.setEnvDomain = function (envDomain) {
            config.envDomain = envDomain;
        };

        me.setBackupCSScript = function () {
            oBackupScript = getScript(config.scriptName);
        };

        me.getBackupCSScript = function () {
            return oBackupScript || {};
        };

        me.getCSScriptCode = function () {
            var oScript = me.getBackupCSScript().script;

            return oScript ? oScript.code : "";
        };

        me.isExtraLayer = function (group) {
            return !(group === BL || group === LB || group === CP);
        };

        me.getNode = function () {
            var resp,
                nodes;

            if (!node && nodeId) {
                resp = me.getEnvInfo();

                if (resp.result != 0) return resp;

                nodes = resp.nodes;

                for (var i = 0, n = nodes.length; i < n; i++) {
                    if (nodes[i].id == nodeId) {
                        node = nodes[i];
                        break;
                    }
                }
            }

            return { result : 0, node : node };
        };

        me.getEnvInfo = function () {
            var resp;

            if (!envInfo) {
                resp = jelastic.env.control.GetEnvInfo(envName, session);
                if (resp.result != 0) return resp;

                envInfo = resp;
            }

            return envInfo;
        };

        me.getEntryPointGroup = function () {
            var group,
                nodes,
                resp;

            resp = me.getEnvInfo();
            if (resp.result != 0) return resp;

            nodes = resp.nodes;

            for (var i = 0, node; node = nodes[i]; i++) {
                if (node.nodeGroup == LB || node.nodeGroup == BL) {
                    group = node.nodeGroup;
                    break;
                }
            }

            return { result : 0, group : group || CP };
        };

        me.attachExtIp = function attachExtIp(nodeId) {
            var platformVersion = getPlatformVersion();

            if (compareVersions(platformVersion, '4.9.5') >= 0 || platformVersion.indexOf('trunk') != -1) {
                return jelastic.env.control.AttachExtIp({ envName : envName, session : session, nodeid : nodeId });
            }

            return jelastic.env.control.AttachExtIp(envName, session, nodeId);
        };

        me.cmd = function (cmd, values, sep, disableLogging) {
            var resp,
                command;

            values = values || {};
            values.log = values.log || logPath;
            cmd = cmd.join ? cmd.join(sep || " && ") : cmd;

            command = _(cmd, values);

            if (!disableLogging) {
                log("cmd: " + command);
            }

            if (values.nodeGroup) {
                resp = jelastic.env.control.ExecCmdByGroup(envName, session, values.nodeGroup, toJSON([{ command: command }]), true, false, "root");
            } else {
                resp = jelastic.env.control.ExecCmdById(envName, session, nodeId, toJSON([{ command: command }]), true, "root");
            }

            return resp;
        };

        me.readFile = function (path) {
            return jelastic.env.file.Read(envName, session, path, null, null, nodeId);
        };

        me.checkCustomSSL = function () {
            var node;

            if (!isDefined(bCustomSSLSupported)) {
                var resp = me.getNode();

                if (resp.result != 0) {
                    log("ERROR: getNode() = " + resp);
                }

                if (resp.node) {
                    node = resp.node;

                    bCustomSSLSupported = node.isCustomSslSupport;

                    if ((!isDefined(bCustomSSLSupported) || node.type != "DOCKERIZED") && node.nodemission != "docker") {
                        resp = me.cmd([
                            "source %(path)",
                            "validateCustomSSL"
                        ], { path : nodeManager.getScriptPath("validation.sh") });

                        bCustomSSLSupported = (resp.result == 0);
                    }
                }

                bCustomSSLSupported = !!bCustomSSLSupported;
            }

            return bCustomSSLSupported;
        };
    }

    function _(str, values) {
        return new StrSubstitutor(values || {}, "%(", ")").replace(str);
    }

    function isDefined(value) {
        return typeof value !== "undefined";
    }

    function getPlatformVersion() {
        return jelastic.system.service.GetVersion().version.split("-").shift();
    }

    function getScript(name) {
        return jelastic.dev.scripting.GetScript(name);
    }

    function compareVersions(a, b) {
        a = a.split("."); b = b.split(".");
        for (var i = 0, l = Math.max(a.length, b.length), x, y; i < l; i++) {x = parseInt(a[i], 10) || 0; y = parseInt(b[i], 10) || 0; if (x != y) return x > y ? 1 : -1 }
        return 0;
    }

    function error(result, text, values) {
        text = _(text, values);
        return { result: result, error: text, response: text, type: "error", message: text };
    }

    function log(message) {
        if (jelastic.marketplace && jelastic.marketplace.console && message) {
            return jelastic.marketplace.console.WriteLog(appid, session, message);
        }

        return { result : 0 };
    }

    function getUserInfo() {
        return jelastic.users.account.GetUserInfo(appid, session);
    }
}
