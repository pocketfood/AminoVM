#!/usr/bin/env node

const { parseResizeArgs, printUsage, resizeDisk } = require('./lib/disk-tools');

function main() {
    let args;

    try {
        args = parseResizeArgs(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        printUsage();
        process.exit(1);
    }

    if (args.help) {
        printUsage();
        return;
    }

    try {
        resizeDisk({
            showInfo: args.showInfo,
            addSize: args.addSize,
            setSize: args.setSize,
            diskPath: args.diskPath,
            backup: args.backup,
        });
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

main();
