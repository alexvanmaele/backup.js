# backup.js


**Description:**

Incremental backups using node.js.


**Features:**

    - Runs as a backup user, not as root
    - Configuration file generator/modifier feature, interactively or command line based
    - Config option to only backup files after a certain date
    - Detect and clean new disk on first use
    - Incremental backups
    - Proper error reporting – disk full, permissions problem, wrong disk, …
    - Test mode that shows what exactly will be done and why – rather than performing the actual backup
    - Sends backup summary to you (configurable email address)
    - Exclude config option to exclude individual files or patterns


**Usage:**

    npm install
    node backup.js


**Arguments:**

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


**Example:**
    
    node backup.js --backupSource=testFiles --backupDestination=testDisk --backupDate=11/11/2014 --testMode=Y --sendMailSummary=N --force-erase