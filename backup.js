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
    if(backupUid !== null)
    {
        try
        {
            process.setuid(backupUid);
        }
        catch(err)
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
    if(runningAsRoot())
    {
        console.log('Root privileges detected.\nTrying to drop to backup user privileges...');
        if(attemptRunAsBackupUser())
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

}

function generateConfigIfNotExists()
{
    if(configFileExists())
    {
        console.log('Config file found');
    }
    else
    {
        console.log('Config file not found - generating new configuration');
        generateNewConfig();
    }
}



// MAIN SCRIPT
(function()
{
    showWelcome();
    tryDropPrivilegesIfRoot();

    generateConfigIfNotExists();
    loadConfig();
    // todo

    showGoodbye();
}());