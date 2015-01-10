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
var prompt = require('prompt');
var promise = require('bluebird');
//var fs = promise.promisifyAll(require("fs"));
var fs = require('fs');
var CONFIG_FILE = './config.json';

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
    if (backupUid !== null)
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
            });
        }
    });
}

function generateNewConfig()
{
    return promptForConfig().
    then(function(result)
    {
        fs.writeFileSync(CONFIG_FILE, result);
    }).
    catch(function(err)
    {
        console.log('Config generation error');
    });
}

function promptForConfig()
{
    return new promise(function(resolve, reject)
    {
        var schema = {
            properties:
            {
                backupSource:
                {
                    description: 'Enter the backup source location',
                    required: true
                },
                backupDestination:
                {
                    description: 'Enter the backup destination drive',
                    required: true
                },
                backupDate:
                {
                    description: 'Enter the max. date of the files that will be backed up (leave blank to include all files)',
                    pattern: /^(?:(?:31(\/|-|\.)(?:0?[13578]|1[02]))\1|(?:(?:29|30)(\/|-|\.)(?:0?[1,3-9]|1[0-2])\2))(?:(?:1[6-9]|[2-9]\d)?\d{2})$|^(?:29(\/|-|\.)0?2\3(?:(?:(?:1[6-9]|[2-9]\d)?(?:0[48]|[2468][048]|[13579][26])|(?:(?:16|[2468][048]|[3579][26])00))))$|^(?:0?[1-9]|1\d|2[0-8])(\/|-|\.)(?:(?:0?[1-9])|(?:1[0-2]))\4(?:(?:1[6-9]|[2-9]\d)?\d{2})$/,
                    message: 'Please enter a valid date in DD/MM/YYYY format',
                    required: false
                },
                logMailReceiver:
                {
                    description: 'Enter your email address to receive a log summary (leave blank to disable)',
                    required: false
                },
                logMailSender:
                {
                    description: 'Enter an email address to send the logs from (Gmail only, leave blank for system default)',
                    required: false
                },
                logMailSenderPassword:
                {
                    description: 'Enter the password for the email address (Gmail, leave blank if none)',
                    required: false
                }
            }
        };
        prompt.message = '';
        prompt.delimiter = '';
        prompt.start();
        prompt.get(schema, function(err, result)
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

function loadConfig()
{
    //todo
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
        showGoodbye();
        //todo
    });
}());