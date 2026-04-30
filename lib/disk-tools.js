const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    loadConfig,
    resolveQemuImgPath,
    resolveRuntimePath,
    runtimeBaseDir,
} = require('./aminovm-core');

function printUsage() {
    console.log(`Usage:
  amino disk resize --path <disk> --size <size>
  amino disk resize --path <disk> --add <size>
  node resize-disk.js --info
  node resize-disk.js --add <size> [--disk <path>] [--no-backup]
  node resize-disk.js --size <size> [--disk <path>] [--no-backup]

Examples:
  amino disk resize --path deb.img --size 80G
  amino disk resize --path deb.img --add 20G
  node resize-disk.js --info
  node resize-disk.js --size 40G --disk deb.img

Notes:
  - Shut down the VM before resizing.
  - This changes the image capacity only. You still must grow the partition/filesystem inside the guest.
`);
}

function parseResizeArgs(argv) {
    const parsed = {
        showInfo: false,
        addSize: null,
        setSize: null,
        diskPath: null,
        backup: true,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }

        if (arg === '--info') {
            parsed.showInfo = true;
            continue;
        }

        if (arg === '--no-backup') {
            parsed.backup = false;
            continue;
        }

        if (arg.startsWith('--add=')) {
            parsed.addSize = arg.split('=', 2)[1];
            continue;
        }

        if (arg === '--add') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --add.');
            }
            parsed.addSize = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith('--size=')) {
            parsed.setSize = arg.split('=', 2)[1];
            continue;
        }

        if (arg === '--size') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --size.');
            }
            parsed.setSize = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith('--disk=')) {
            parsed.diskPath = arg.split('=', 2)[1];
            continue;
        }

        if (arg === '--disk') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --disk.');
            }
            parsed.diskPath = argv[i + 1];
            i += 1;
            continue;
        }

        if (arg.startsWith('--path=')) {
            parsed.diskPath = arg.split('=', 2)[1];
            continue;
        }

        if (arg === '--path') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) {
                throw new Error('Missing value for --path.');
            }
            parsed.diskPath = argv[i + 1];
            i += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    if (parsed.help) {
        return parsed;
    }

    if (parsed.addSize && parsed.setSize) {
        throw new Error('Use only one of --add or --size.');
    }

    if (!parsed.showInfo && !parsed.addSize && !parsed.setSize) {
        throw new Error('Nothing to do. Use --info, --add, or --size.');
    }

    return parsed;
}

function loadDiskPath(explicitDiskPath) {
    if (explicitDiskPath) {
        return resolveRuntimePath(explicitDiskPath);
    }

    const config = loadConfig();
    return resolveRuntimePath(config.diskPath);
}

function runQemuImg(qemuImgPath, args) {
    const result = spawnSync(qemuImgPath, args, {
        stdio: 'pipe',
        encoding: 'utf8',
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        const stdout = (result.stdout || '').trim();
        throw new Error(stderr || stdout || `qemu-img exited with code ${result.status}`);
    }

    return (result.stdout || '').trim();
}

function normalizeSizeToken(rawValue, mode) {
    const value = String(rawValue || '').trim();
    const match = value.match(/^([+-]?)(\d+)([a-zA-Z]*)$/);

    if (!match) {
        throw new Error(
            `Invalid ${mode} size "${rawValue}". Use formats like 20G, 20480M, 21474836480, or 20GB.`
        );
    }

    const sign = match[1];
    const numberPart = match[2];
    const unitRaw = (match[3] || '').toLowerCase();

    const unitMap = {
        '': '',
        b: '',
        byte: '',
        bytes: '',
        k: 'K',
        kb: 'K',
        kib: 'K',
        m: 'M',
        mb: 'M',
        mib: 'M',
        g: 'G',
        gb: 'G',
        gib: 'G',
        t: 'T',
        tb: 'T',
        tib: 'T',
        p: 'P',
        pb: 'P',
        pib: 'P',
        e: 'E',
        eb: 'E',
        eib: 'E',
    };

    if (!(unitRaw in unitMap)) {
        throw new Error(`Invalid unit "${match[3]}". Use k, M, G, T, P, E (or kb/mb/gb/tb style aliases).`);
    }

    return `${sign}${numberPart}${unitMap[unitRaw]}`;
}

function resolveResizeSpec(args) {
    if (args.addSize) {
        const normalized = normalizeSizeToken(args.addSize, '--add');
        if (normalized.startsWith('-')) {
            throw new Error('--add only supports positive growth.');
        }

        return normalized.startsWith('+') ? normalized : `+${normalized}`;
    }

    const normalized = normalizeSizeToken(args.setSize, '--size');
    if (normalized.startsWith('-')) {
        throw new Error('--size must be a non-negative absolute size.');
    }

    return normalized.startsWith('+') ? normalized.slice(1) : normalized;
}

function makeBackup(diskPath) {
    const backupRoot = path.join(runtimeBaseDir, 'imgbackup');
    fs.mkdirSync(backupRoot, { recursive: true });

    const baseName = path.basename(diskPath);
    const now = new Date();
    const timestamp = [
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
    ].join('');

    const backupPath = path.join(backupRoot, `${baseName}.bk-${timestamp}`);
    fs.copyFileSync(diskPath, backupPath);
    return backupPath;
}

function resizeDisk(options = {}) {
    const args = {
        showInfo: Boolean(options.showInfo),
        addSize: options.addSize || null,
        setSize: options.setSize || null,
        diskPath: options.diskPath || null,
        backup: options.backup !== false,
    };

    const qemuImgPath = resolveQemuImgPath();
    if (!fs.existsSync(qemuImgPath)) {
        throw new Error(`qemu-img not found at ${qemuImgPath}`);
    }

    const diskPath = loadDiskPath(args.diskPath);
    if (!fs.existsSync(diskPath)) {
        throw new Error(`Disk image not found: ${diskPath}`);
    }

    console.log(`Disk image: ${diskPath}`);
    console.log('Current image info:');
    console.log(runQemuImg(qemuImgPath, ['info', diskPath]));

    if (args.showInfo) {
        return;
    }

    const resizeSpec = resolveResizeSpec(args);

    if (args.backup) {
        console.log('\nCreating backup before resize...');
        const backupPath = makeBackup(diskPath);
        console.log(`Backup created: ${backupPath}`);
    } else {
        console.log('\nBackup skipped (--no-backup).');
    }

    console.log(`\nResizing image with: qemu-img resize "${diskPath}" "${resizeSpec}"`);
    console.log(runQemuImg(qemuImgPath, ['resize', diskPath, resizeSpec]));

    console.log('\nUpdated image info:');
    console.log(runQemuImg(qemuImgPath, ['info', diskPath]));
    console.log('\nResize complete. Expand partitions/filesystems inside the VM to use the new space.');
}

module.exports = {
    parseResizeArgs,
    printUsage,
    resizeDisk,
};
