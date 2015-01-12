/*
backup.js - A backup script in node.js

Features:
    - Runs as a backup user, not as root
    - Configuration file generator/modifier feature, interactively or command line based
    - Config option to only backup files after a certain date
    - Detect and clean new disk on first use
    - Incremental backups
    - Proper error reporting – disk full, permissions problem, wrong disk, …
    - Test mode that shows what exactly will be done and why – rather than performing the actual backup
    - Sends backup summary to you (configurable email address)
    - Exclude config option to exclude individual files or patterns

Usage:
    npm install
    node backup.js

Arguments:
    --backupSource: Source folder to backup
    --backupDestination: Where to save the backup. A disk root is assumed
    --backupDate: Files modified before this date will be ignored
    --exclude: Exclude files by name. Has limited regex support with global flag set by default
    --testMode: Don't copy anything, just print a preview (Y/N)
    --sendMailSummary: Send a summary of the backup by mail (Y/N)
    --logMailReceiver: Address to receive the backup summary
    --logMailSender: Address used to send the backup summary (only Gmail is supported right now)
    --logMailSenderPassword: Password for the sending address
    --force-erase: Don't ask before erasing a non-empty backup destination
    --reset-config: Remove the existing config in order to generate a new one

Example:
    node backup.js --backupSource=testFiles --backupDestination=testDisk --backupDate= --testMode=Y --sendMailSummary=N --force-erase

*/
var userid = require('userid');
var promise = require('bluebird');
var fs = promise.promisifyAll(require("fs-extra"));
var prompt = promise.promisifyAll(require('prompt'));
var extfs = require('extfs');
var path = require('path');
var argv = require('minimist')(process.argv.slice(2)); //command line arguments
var winston = require('winston');
var util = require('util');
var nodemailer = require('nodemailer');
// config
var logger;
var logMessages = [];
var CONFIG_FILE = './config.json';
var LOG_PREFIX = 'backup-js';
var DISK_SIGNATURE_FILE = 'backupjs.signature';
var backupReasons = {
    DEST_FILE_NOT_FOUND: 'Destination file not found',
    SRC_FILE_NEWER: 'Source file is newer than destination file'
};
var config;

function initLogging()
{
    initMainLogger();
    initFileLogger();
    initCustomLogger();
}

function initMainLogger()
{
    logger = new(winston.Logger)(
    {});
    var consoleLogger = winston.transports.consoleLogger = function(options)
    {
        this.name = 'consoleLogger';
        this.level = 'info';
    };
    util.inherits(consoleLogger, winston.Transport);
    consoleLogger.prototype.log = function(level, msg, meta, callback)
    {
        console.log(msg);
        callback(null, true);
    };
    logger.add(consoleLogger);
}

function initFileLogger()
{
    var timestamp = Math.floor(new Date() / 1000);
    var logFileName = LOG_PREFIX + timestamp + '.log';
    if (logFileIsWriteable(logFileName))
    {
        logger.add(winston.transports.File,
        {
            filename: logFileName
        });
    }
}

function initCustomLogger()
{
    var customLogger = winston.transports.customerLogger = function(options)
    {
        this.name = 'customLogger';
        this.level = 'info';
    };
    util.inherits(customLogger, winston.Transport);
    customLogger.prototype.log = function(level, msg, meta, callback)
    {
        var timestamp = '[' + new Date().toLocaleTimeString() + ']';
        var logItem = timestamp + ' ' + level + ' : ' + msg;
        logMessages.push(logItem);
        callback(null, true);
    };
    logger.add(customLogger);
}

function logFileIsWriteable(logFile)
{
    try
    {
        if (fs.existsSync(logFile)) throw 'Error: Log file with same name already exists';
        fs.writeFileSync(logFile, 'log test data');
        fs.unlinkSync(logFile);
        return true;
    }
    catch (err)
    {
        logger.error('Error handling log file: ' + err);
        return false;
    }
}

function clearConsole()
{
    console.log('\033[2J');
}

function showWelcome()
{
    clearConsole();
    logger.info('backup.js - Welcome!\n');
}

function showGoodbye()
{
    logger.info('\nbackup.js finished execution - Goodbye!');
}

function runningAsRoot()
{
    return process.getuid() === userid.uid('root');
}

function attemptRunAsBackupUser()
{
    var backupUid = userid.uid('backup');
    if (backupUid !== undefined)
    {
        try
        {
            process.setuid(backupUid);
        }
        catch (err)
        {
            return false;
        }
        return true;
    }
    else
    {
        return false;
    }
}

function tryDropPrivilegesIfRoot()
{
    if (runningAsRoot())
    {
        logger.info('Root privileges detected.\nTrying to drop to backup user privileges...');
        if (attemptRunAsBackupUser())
        {
            logger.info('Dropped succesfully');
        }
        else
        {
            logger.info('Drop failed. Proceeding as root (dangerous)');
        }
    }
}

function configFileExists()
{
    return fs.existsSync(CONFIG_FILE);
}

function generateConfigIfNotExists()
{
    return new promise(function(resolve, reject)
    {
        if (configFileExists())
        {
            logger.info('Config file found');
            if (argv['reset-config'] === true)
            {
                logger.info('Warning: existing config will be reset!');
                generateNewConfig().
                then(function()
                {
                    resolve();
                }).
                catch (function(err)
                {
                    logger.info('Config generation error');
                    logger.info(err);
                });
            }
            else
            {
                resolve();
            }
        }
        else
        {
            logger.info('Config file not found - generating new configuration...');
            generateNewConfig().
            then(function()
            {
                resolve();
            }).
            catch (function(err)
            {
                logger.info('Config generation error');
                logger.info(err);
            });
        }
    });
}

function generateNewConfig()
{
    return promptForConfig().
    then(function(result)
    {
        var prettyJson = JSON.stringify(result, undefined, 2);
        fs.writeFileSync(CONFIG_FILE, prettyJson);
    }).
    catch (function(err)
    {
        if (err.code === 'EACCES')
        {
            throw ('Error: permission denied while writing config. Do you have enough rights? (' + process.getuid() + ')');
        }
        else
        {
            throw (err);
        }
    });
}

function promptForConfig()
{
    var validLocationCheck = function(input)
    {
        if (checkValidLocation(input) === false)
        {
            logger.info('Invalid location');
            return false;
        }
        else
        {
            return true;
        }
    };
    var backupConfigScheme = {
        properties:
        {
            backupSource:
            {
                description: 'Enter the backup source location:',
                required: true,
                conform: function(input)
                {
                    return validLocationCheck(input);
                }
            },
            backupDestination:
            {
                description: 'Enter the backup destination drive:',
                required: true,
                conform: function(input)
                {
                    return validLocationCheck(input);
                }
            },
            backupDate:
            {
                description: 'Enter the max. file date (leave blank to include all):',
                conform: function(input)
                {
                    if (input.length < 1) return true; //can be blank
                    else return (isNaN(Date.parse(input)) === false);
                },
                required: false
            },
            exclude:
            {
                description: 'Enter a regex used to exclude files (leave blank to include all):',
                conform: function(input)
                {
                    try
                    {
                        var regex = new RegExp(input);
                        if (regex !== undefined) return true;
                    }
                    catch (err)
                    {
                        return false;
                    }
                },
                required: false
            },
            testMode:
            {
                description: 'Do you want to run in test mode? Backup will be calculated but not performed [y/N]',
                default: 'N',
                pattern: /[YN]/i,
                message: 'Please enter \'Y\' or \'N\'',
                required: true,
                /*before: function(input)
                {
                    return input.toUpperCase() === 'Y';
                }*/
            },
            sendMailSummary:
            {
                description: 'Do you want to receive a mail log summary? [Y/n]',
                default: 'Y',
                pattern: /[YN]/i,
                message: 'Please enter \'Y\' or \'N\'',
                required: true,
                /*before: function(input)
                {
                    return input.toUpperCase() === 'Y';
                }*/
            }
        }
    };
    var mailConfigScheme = {
        properties:
        {
            logMailReceiver:
            {
                description: 'Enter a mail address to receive a log summary:',
                required: true
            },
            logMailSender:
            {
                description: 'Enter a mail address used to send logs (Gmail only, leave blank for system default):',
                required: false
            },
        }
    };
    var mailSenderConfigScheme = {
        properties:
        {
            logMailSenderPassword:
            {
                description: 'Enter the password for this mail address (Gmail only):',
                required: false,
                hidden: true
            }
        }
    };
    var config;
    return promptFor(backupConfigScheme).
    then(function(result)
    {
        var mailConfig;
        if (result.sendMailSummary.toUpperCase() === 'Y')
        {
            mailConfig = promptFor(mailConfigScheme);
        }
        return [result, mailConfig];
    }).spread(function(result, mailConfig)
    {
        config = result;
        config.mailConfig = mailConfig;
        if (mailConfig !== undefined && mailConfig.logMailSender.length > 0)
        {
            return promptFor(mailSenderConfigScheme);
        }
    }).then(function(mailSenderConfig)
    {
        if (mailSenderConfig !== undefined)
        {
            config.mailConfig.logMailSenderPassword = mailSenderConfig.logMailSenderPassword;
        }
        return config;
    });
}

function promptFor(scheme)
{
    prompt.message = '';
    prompt.delimiter = '';
    prompt.colors = false;
    prompt.override = argv;
    prompt.start();
    return new promise(function(resolve, reject)
    {
        prompt.get(scheme, function(err, result)
        {
            if (err)
            {
                reject(err);
            }
            else
            {
                resolve(result);
            }
        });
    });
}

function checkValidLocation(dir)
{
    try
    {
        return fs.existsSync(dir);
    }
    catch (err)
    {
        logger.info(err);
        return false;
    }
}

function loadConfig()
{
    try
    {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE));
    }
    catch (err)
    {
        logger.info('Error reading config file');
        throw (err);
    }
}

function initDisk(disk)
{
    return new promise(function(resolve, reject)
    {
        if (diskIsValid(disk) === false)
        {
            logger.info('New disk detected');
            if (argv['force-erase'] === true)
            {
                eraseDisk(disk);
                markDisk(disk);
                resolve();
            }
            else
            {
                eraseIfNotEmpty(disk).
                then(function()
                {
                    markDisk(disk);
                    resolve();
                });
            }
        }
        else
        {
            logger.info('Valid disk detected');
            resolve();
        }
    });
}

function eraseIfNotEmpty(disk)
{
    return new promise(function(resolve, reject)
    {
        if (extfs.isEmptySync(disk) === false)
        {
            logger.info('WARNING: Disk is not empty! Do you want to erase the disk?');
            promptForConfirm().
            then(function(result)
            {
                if (result.confirmed === true)
                {
                    eraseDisk(disk);
                }
                else
                {
                    logger.info('Disk has not been erased');
                }
                resolve();
            }).
            catch (function(err)
            {
                logger.info(err);
            });
        }
        else
        {
            resolve();
        }
    });
}

function promptForConfirm()
{
    var confirmScheme = {
        properties:
        {
            confirmed:
            {
                description: 'Type \'yes\' to confirm:',
                required: false,
                before: function(input)
                {
                    if (input.toLowerCase() === 'yes')
                    {
                        return true;
                    }
                    else
                    {
                        return false;
                    }
                }
            }
        }
    };
    return promptFor(confirmScheme);
}

function eraseDisk(diskRoot)
{
    try
    {
        cleanDir(diskRoot);
        logger.info('Disk has been erased');
    }
    catch (err)
    {
        logger.info('Error erasing disk');
        if (err.code === 'EACCES')
        {
            throw ('Error: insufficient permissions to erase disk');
        }
        else
        {
            throw (err);
        }
    }
}

function cleanDir(dirPath)
{
    var files = fs.readdirSync(dirPath);
    if (files.length > 0)
    {
        for (var i = 0; i < files.length; i++)
        {
            var filePath = dirPath + '/' + files[i];
            if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath);
            else cleanDir(filePath);
        }
    }
}

function markDisk(diskRoot)
{
    try
    {
        var mark = 'backup.js - disk cleared on ' + Date();
        mark += '\nDo not remove this file, it is used by backup.js to verify the disk';
        fs.writeFileSync(diskRoot + '/' + DISK_SIGNATURE_FILE, mark);
    }
    catch (err)
    {
        logger.info('Error marking disk');
        if (err.code === 'EACCES')
        {
            throw ('Error: insufficient permissions to mark disk');
        }
        else
        {
            throw (err);
        }
    }
}

function diskIsValid(disk)
{
    return fs.existsSync(disk + '/' + DISK_SIGNATURE_FILE);
}

function buildPendingBackupList(source, destination)
{
    var sourceFileTree = getFileTree(source, config.backupSource);
    // flat tree is easier to manage, but we include the full tree in case we want to visualize later
    var sourceFileList = flattenFileTree(sourceFileTree);
    var destinationFileTree = getFileTree(destination, config.backupDestination);
    var destinationFileList = flattenFileTree(destinationFileTree);
    var pendingFilesList = getPendingFilesFromLists(sourceFileList, destinationFileList);
    logger.info('New files found: ' + pendingFilesList.length);
    if (pendingFilesList.length > 0)
    {
        pendingFilesList = filterListByMinDate(pendingFilesList, config.backupDate);
        logger.info('Files remaining after date filter: ' + pendingFilesList.length);
    }
    if (pendingFilesList.length > 0)
    {
        pendingFilesList = filterByRegex(pendingFilesList, config.exclude);
        logger.info('Files remaining after regex filter: ' + pendingFilesList.length);
    }
    return pendingFilesList;
}

function getFileTree(filename, root)
{
    var stats = fs.lstatSync(filename);
    var info = {
        path: filename,
        relativePath: filename.substring(root.length + 1, filename.length),
        name: path.basename(filename),
        lastModified: stats.mtime
    };
    if (stats.isDirectory())
    {
        info.type = "folder";
        info.children = fs.readdirSync(filename).map(function(child)
        {
            return getFileTree(filename + '/' + child, root);
        });
    }
    else
    {
        info.type = "file";
    }
    return info;
}

function flattenFileTree(tree)
{
    var children = getChildren(tree);
    //logger.info(JSON.stringify(children, null, 2));
    return children;
}

function getChildren(parent)
{
    var children = [];
    if (parent.children)
    {
        for (var i = 0; i < parent.children.length; i++)
        {
            var child = parent.children[i];
            if (child.children)
            {
                var subChildren = getChildren(child);
                for (var childNr in subChildren)
                {
                    children.push(subChildren[childNr]);
                }
            }
            else
            {
                children.push(child);
            }
        }
    }
    return children;
}

function filterListByMinDate(fileList, minDate)
{
    var minDateParsed = Date.parse(minDate);
    if (isNaN(minDateParsed)) // no date set
    {
        return fileList;
    }
    var filteredList = [];
    for (var fileNr in fileList)
    {
        var file = fileList[fileNr];
        var fileModDate = Date.parse(file.lastModified);
        if (fileModDate >= minDateParsed)
        {
            filteredList.push(file);
        }
    }
    return filteredList;
}

function filterByRegex(fileList, regex)
{
    var filter = new RegExp(regex, 'g');
    var filteredList = [];
    for (var fileNr in fileList)
    {
        var file = fileList[fileNr];
        if (file.name.match(filter) === null)
        {
            filteredList.push(file);
        }
    }
    return filteredList;
}

function getPendingFilesFromLists(sourceList, destinationList)
{
    var pendingFilesList = [];
    for (var fileNr in sourceList)
    {
        var sourceFile = sourceList[fileNr];
        var destinationClone = findFileInList(sourceFile, destinationList);
        if (destinationClone === undefined)
        {
            sourceFile.reason = backupReasons.DEST_FILE_NOT_FOUND;
            pendingFilesList.push(sourceFile);
        }
        else
        {
            if (compareFilesByDate(sourceFile, destinationClone) === 1) //source is newer
            {
                sourceFile.reason = backupReasons.SRC_FILE_NEWER;
                pendingFilesList.push(sourceFile);
            }
        }
    }
    return pendingFilesList;
}

function findFileInList(file, fileList)
{
    for (var fileNr in fileList)
    {
        var listFile = fileList[fileNr];
        if (listFile.relativePath === file.relativePath)
        {
            return listFile;
        }
    }
}

function compareFilesByDate(fileA, fileB)
{
    var dateA = Date.parse(fileA.lastModified);
    var dateB = Date.parse(fileB.lastModified);
    if (dateA > dateB) return 1;
    if (dateA === dateB) return 0;
    if (dateA < dateB) return -1;
}

function printTestModeBackupList(backupList)
{
    if (backupList.length < 1)
    {
        logger.info('There are no files to backup!');
        return;
    }
    logger.info('Following files are different on source:\n');
    logger.info(JSON.stringify(backupList, null, 2));
    logger.info('\nRunning in test mode.\nThis is only a preview: files will not be backed up!');
}

function performBackup(fileList)
{
    if (fileList.length < 1)
    {
        logger.info('No files to backup!');
        return;
    }
    logger.info('Performing backup...');
    var overwriteCount = 0;
    for (var fileNr in fileList)
    {
        var file = fileList[fileNr];
        var stats = fs.statSync(file.path);
        var backupPath = config.backupDestination + '/' + file.relativePath;
        if (fs.existsSync(backupPath))
        {
            fs.unlinkSync(backupPath); //delete
            overwriteCount++;
        }
        fs.copySync(file.path, backupPath);
        fs.utimesSync(backupPath, stats.atime, stats.mtime); //sync timestamsp
    }
    logger.info('Backup complete!');
    logger.info('Backed up %s %s (Updated: %s)', fileList.length, fileList.length === 1 ? 'file' : 'files', overwriteCount);
}

function mailLogSummary()
{
    logger.info('Sending mail summary...');
    var logSummary = generateLogSummary();
    var transporter;
    var mailConfig = config.mailConfig;
    if (mailConfig.logMailSender !== undefined)
    {
        transporter = getGmailTransporter(mailConfig.logMailSender, mailConfig.logMailSenderPassword); //only Gmail for now
    }
    else
    {
        transporter = nodemailer.createTransport(); //default transport
    }
    return new promise(function(resolve, reject)
    {
        transporter.sendMail(
        {
            from: mailConfig.logMailSender || mailConfig.logMailReceiver, //use receiver if no sender
            to: mailConfig.logMailReceiver,
            subject: 'backup.js Log Summary [' + Math.floor(new Date() / 1000) + ']',
            text: logSummary
        }, function(err)
        {
            if (err)
            {
                reject(err);
            }
            else
            {
                logger.info('Mail summary sent to ' + mailConfig.logMailReceiver);
                resolve();
            }
        });
    });
}

function generateLogSummary()
{
    var summaryString = 'backup.js Log Summary - ' + new Date().toDateString();
    summaryString += '\n' + Array(68).join("=") + '\n'; // print 68 x '='
    for (var line = 0; line < logMessages.length; line++)
    {
        summaryString += logMessages[line] + '\n';
    }
    summaryString += Array(68).join("=") + '\n';
    summaryString += 'Generated by backup.js - https://github.com/alexvanmaele/backup.js\n';
    summaryString += Array(68).join("=");
    return summaryString;
}

function getGmailTransporter(user, pass)
{
    var transporter = nodemailer.createTransport(
    {
        service: 'gmail',
        auth:
        {
            user: user,
            pass: pass
        }
    });
    return transporter;
}
// MAIN SCRIPT
(function()
{
    var startTime = new Date();
    initLogging();
    showWelcome();
    tryDropPrivilegesIfRoot();
    generateConfigIfNotExists().
    then(function()
    {
        loadConfig();
        return initDisk(config.backupDestination);
    }).
    then(function()
    {
        var pendingBackupList = buildPendingBackupList(config.backupSource, config.backupDestination);
        if (config.testMode.toUpperCase() === 'Y')
        {
            printTestModeBackupList(pendingBackupList);
        }
        else
        {
            performBackup(pendingBackupList);
        }
    }).
    then(function()
    {
        if (config.sendMailSummary.toUpperCase() === 'Y')
        {
            return mailLogSummary();
        }
    }).
    then(function()
    {
        showGoodbye();
        var totalExecutionTime = new Date() - startTime;
        logger.info('Total execution time: %sms', totalExecutionTime);
    }).
    catch (function(err)
    {
        logger.error('An unexpected error occurred');
        logger.error(err.toString());
    });
}());