/*
Features:
- Runs as a backup user, not as root
- Configuration file generator/modifier feature, interactively or command line based
- Config option to only backup files after a certain date
- Detect and clean new disk on first use
- Incremental backups
- Proper error reporting – disk full, permissions problem, wrong disk, …
- Test mode that shows what exactly will be done and why – rather than performing the actual backup
- Sends backup summary to you (configurable email address)
*/
var userid = require('userid');
var promise = require('bluebird');
var fs = promise.promisifyAll(require("fs"));
var prompt = promise.promisifyAll(require('prompt'));
var extfs = require('extfs');
var path = require('path');
// config
var CONFIG_FILE = './config.json';
var DISK_SIGNATURE_FILE = 'backupjs.signature';
var backupReasons = {
    DEST_FILE_NOT_FOUND: 'Destination file not found',
    SRC_FILE_NEWER: 'Source file is newer than destination file'
};
var config;

function clearConsole()
{
    console.log('\033[2J');
}

function showWelcome()
{
    console.time('Total execution time');
    clearConsole();
    console.log('backup.js - Welcome!\n');
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
                pattern: /^(?:(?:31(\/|-|\.)(?:0?[13578]|1[02]))\1|(?:(?:29|30)(\/|-|\.)(?:0?[1,3-9]|1[0-2])\2))(?:(?:1[6-9]|[2-9]\d)?\d{2})$|^(?:29(\/|-|\.)0?2\3(?:(?:(?:1[6-9]|[2-9]\d)?(?:0[48]|[2468][048]|[13579][26])|(?:(?:16|[2468][048]|[3579][26])00))))$|^(?:0?[1-9]|1\d|2[0-8])(\/|-|\.)(?:(?:0?[1-9])|(?:1[0-2]))\4(?:(?:1[6-9]|[2-9]\d)?\d{2})$/,
                message: 'Please enter a valid date in DD/MM/YYYY format',
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
            eraseIfNotEmpty(disk).
            then(function()
            {
                markDisk(disk);
                resolve();
            });
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
    console.log('New files found: ' + pendingFilesList.length);
    //console.log(pendingFilesList);
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
// MAIN SCRIPT
(function()
{
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
            //performBackup(pendingBackupList);
            //todo: possible return promise here
        }
    }).
    finally(function()
    {
        showGoodbye();
    }).
    catch (function(err)
    {
        console.log('An unexpected error occurred');
        console.log(err);
    });
}());