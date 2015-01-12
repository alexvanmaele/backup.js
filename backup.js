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

Usage:
    npm install
    node backup.js

Arguments:
    --backupSource: Source folder to backup
    --backupDestination: Where to save the backup. A disk root is assumed
    --backupDate: Files modified before this date will be ignored
    --testMode: Don't copy anything, just print a preview (Y/N)
    --sendMailSummary: Send a summary of the backup by mail (Y/N)
    --logMailReceiver: Address to receive the backup summary
    --logMailSender: Address used to send the backup summary (only Gmail is supported right now)
    --logMailSenderPassword: Password for the sending address
    --force-erase: Don't ask before erasing a non-empty backup destination

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
    console.time('Total execution time');
    clearConsole();
    logger.info('backup.js - Welcome!\n');
}

function showGoodbye()
{
    console.log('\nbackup.js finished execution - Goodbye!');
    console.timeEnd('Total execution time');
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
        console.log('Root privileges detected.\nTrying to drop to backup user privileges...');
        if (attemptRunAsBackupUser())
        {
            console.log('Dropped succesfully');
        }
        else
        {
            console.log('Drop failed. Proceeding as root (dangerous)');
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
            console.log('Config file found');
            resolve();
        }
        else
        {
            console.log('Config file not found - generating new configuration...');
            generateNewConfig().
            then(function()
            {
                resolve();
            }).
            catch (function(err)
            {
                console.log('Config generation error');
                console.log(err);
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
            console.log('Invalid location');
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
                before: function(input)
                {
                    return new Date(input);
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
                before: function(input)
                {
                    return input.toUpperCase() == 'Y';
                }
            },
            sendMailSummary:
            {
                description: 'Do you want to receive a mail log summary? [Y/n]',
                default: 'Y',
                pattern: /[YN]/i,
                message: 'Please enter \'Y\' or \'N\'',
                required: true,
                before: function(input)
                {
                    return input.toUpperCase() == 'Y';
                }
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
        if (result.sendMailSummary === true)
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
        console.log(err);
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
        console.log('Error reading config file');
        throw (err);
    }
}

function initDisk(disk)
{
    return new promise(function(resolve, reject)
    {
        if (diskIsValid(disk) === false)
        {
            console.log('New disk detected');
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
            console.log('Valid disk detected');
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
            console.log('WARNING: Disk is not empty! Do you want to erase the disk?');
            promptForConfirm().
            then(function(result)
            {
                if (result.confirmed === true)
                {
                    eraseDisk(disk);
                }
                else
                {
                    console.log('Disk has not been erased');
                }
                resolve();
            }).
            catch (function(err)
            {
                console.log(err);
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
        console.log('Disk has been erased');
    }
    catch (err)
    {
        console.log('Error erasing disk');
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
        console.log('Error marking disk');
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
    //console.log(sourceFileList);
    //console.log('Files found in source folder: ' + sourceFileList.length);
    var destinationFileTree = getFileTree(destination, config.backupDestination);
    var destinationFileList = flattenFileTree(destinationFileTree);
    //console.log(destinationFileList);
    //console.log('Files found in destination folder: ' + destinationFileList.length);
    var pendingFilesList = getPendingFilesFromLists(sourceFileList, destinationFileList);
    //console.log('New files found: ' + pendingFilesList.length);
    //console.log(pendingFilesList);
    var filteredPendingFilesList = filterListByMinDate(pendingFilesList, config.backupDate);
    if (pendingFilesList.length > 0)
    {
        console.log('Filtered files by date: ' + (pendingFilesList.length - filteredPendingFilesList.length));
        //console.log(pendingFilesList);
    }
    return filteredPendingFilesList;
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
    //console.log(JSON.stringify(children, null, 2));
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
    var filteredList = [];
    for (var fileNr in fileList)
    {
        var file = fileList[fileNr];
        var fileModDate = Date.parse(file.lastModified);
        if (fileModDate >= Date.parse(minDate))
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
    console.log('Following files are different on source:\n');
    console.log(backupList);
    console.log('\nRunning in test mode.\nThis is only a preview: files will not be backed up!');
}

function performBackup(fileList)
{
    if (fileList.length < 1)
    {
        console.log('No files to backup!');
        return;
    }
    console.log('Performing backup...');
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
    console.log('Backup complete!');
    console.log('Backed up %s %s (Updated: %s)', fileList.length, fileList.length === 1 ? 'file' : 'files', overwriteCount);
}
// MAIN SCRIPT
(function()
{
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
        if (config.testMode === true)
        {
            printTestModeBackupList(pendingBackupList);
        }
        else
        {
            performBackup(pendingBackupList);
        }
    }).
    finally(function()
    {
        showGoodbye();
    }).
    catch (function(err)
    {
        logger.error('An unexpected error occurred');
        logger.error(err);
    });
}());