#!/usr/bin/env node

const fs = require('fs');

const {
    buildForPlatform,
    configPath,
    displayUsesGuiWindow,
    findVmProcesses,
    launchVM,
    listImageFiles,
    loadConfig,
    resolveRuntimePath,
    runtimeBaseDir,
    saveConfig,
    stopVM,
    toConfigPath,
    vmName,
} = require('./lib/aminovm-core');
const { resizeDisk } = require('./lib/disk-tools');

function printUsage() {
    console.log(`Usage:
  amino launch [--headless] [--tray] [--window]
  amino stop
  amino status

  amino ports list
  amino ports add --host 127.0.0.1 --hport 8080 --gport 9092 [--guest 10.0.2.15]
  amino ports remove --host 127.0.0.1 --hport 8080

  amino disk resize --path deb.img --size 80G
  amino disk resize --path deb.img --add 20G

  amino image list
  amino image select --path deb.img
  amino image install --path some.iso

  amino build windows
  amino build linux
  amino build macos
`);
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

function parseOptionMap(args) {
    const parsed = { _: [] };

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];

        if (!arg.startsWith('--')) {
            parsed._.push(arg);
            continue;
        }

        const trimmed = arg.slice(2);
        const separatorIndex = trimmed.indexOf('=');

        if (separatorIndex !== -1) {
            const key = trimmed.slice(0, separatorIndex);
            const value = trimmed.slice(separatorIndex + 1);
            parsed[key] = value;
            continue;
        }

        const nextArg = args[i + 1];
        if (!nextArg || nextArg.startsWith('--')) {
            parsed[trimmed] = true;
            continue;
        }

        parsed[trimmed] = nextArg;
        i += 1;
    }

    return parsed;
}

function parseIntegerOption(options, key) {
    if (!(key in options)) {
        return null;
    }

    const value = Number(options[key]);
    if (!Number.isInteger(value)) {
        fail(`Option --${key} must be an integer.`);
    }

    return value;
}

function ensureOption(options, key, message) {
    if (!(key in options) || options[key] === true || options[key] === '') {
        fail(message || `Missing required option --${key}.`);
    }

    return options[key];
}

function normalizeForwardGuestAddress(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const trimmed = value.trim();
    const normalized = trimmed.toLowerCase();
    if (trimmed === '' || normalized === 'guest' || normalized === 'default' || trimmed === '10.0.2.15') {
        return '';
    }

    return trimmed;
}

function formatForward(forward, index) {
    const protocol = forward.protocol || 'tcp';
    const hostAddress = forward.hostAddress || '0.0.0.0';
    const guestAddress = normalizeForwardGuestAddress(forward.guestAddress) || 'guest';
    return `${index + 1}. ${protocol} ${hostAddress}:${forward.hostPort} -> ${guestAddress}:${forward.guestPort}`;
}

function getCurrentConfigSummary(config) {
    const lines = [
        `VM name: ${vmName}`,
        `Config: ${configPath}`,
        `Disk image: ${config.diskPath}`,
        `ISO boot: ${config.useIso ? `enabled (${config.isoPath})` : 'disabled'}`,
        `Display: ${config.display}`,
        `Video device: ${config.videoDevice || (config.compatMode ? 'std' : 'virtio-vga')}`,
        `Show console: ${config.showConsole ? 'yes' : 'no'}`,
        `Tray mode: ${config.tray?.enabled ? 'yes' : 'no'}`,
        `Host forwards: ${config.hostForwards.length}`,
    ];

    return lines.join('\n');
}

function handleLaunch(args) {
    const options = parseOptionMap(args);
    const overrides = {};
    const baseConfig = loadConfig();
    const trayEnabled = !options.window && (options.tray || baseConfig.tray?.enabled);

    if (options.headless) {
        overrides.display = 'none';
    }

    if (trayEnabled) {
        overrides.tray = { ...(baseConfig.tray || {}), enabled: true };
        overrides.display = 'none';
        overrides.showConsole = false;
    }

    if (options.window) {
        overrides.tray = { ...(baseConfig.tray || {}), enabled: false };
    }

    if (options.console) {
        overrides.showConsole = true;
    }

    const launched = launchVM(overrides);

    if (launched.alreadyRunning) {
        const processLabel = launched.pids && launched.pids.length > 0
            ? launched.pids.join(', ')
            : 'unknown';
        console.log(`${vmName} is already running (PID ${processLabel}).`);
        return;
    }

    if (trayEnabled) {
        const cockpitUrl = (overrides.tray?.cockpitUrl || baseConfig.tray?.cockpitUrl || 'https://127.0.0.1:9090').trim();
        console.log(`Launched ${vmName} with PID ${launched.pid || 'unknown'} in tray mode.`);
        console.log(`The VM is running headless and can be opened from the tray icon or at ${cockpitUrl}.`);
        return;
    }

    if (options.headless || (overrides.display === 'none' && !displayUsesGuiWindow(baseConfig.display))) {
        console.log(`Launched ${vmName} with PID ${launched.pid || 'unknown'} in headless mode.`);
        console.log('Use VNC on 127.0.0.1:5901 if VNC is enabled in config.json.');
        return;
    }

    console.log(`Launched ${vmName} with PID ${launched.pid || 'unknown'}.`);
}

function handleStop() {
    const stoppedProcesses = stopVM();

    if (stoppedProcesses.length === 0) {
        console.log(`${vmName} is not running.`);
        return;
    }

    console.log(`Stopped ${vmName} process(es): ${stoppedProcesses.map((processInfo) => processInfo.pid).join(', ')}`);
}

function handleStatus() {
    const config = loadConfig();
    const processes = findVmProcesses();

    console.log(getCurrentConfigSummary(config));
    console.log(`Running: ${processes.length > 0 ? 'yes' : 'no'}`);

    if (processes.length > 0) {
        console.log(`Process IDs: ${processes.map((processInfo) => processInfo.pid).join(', ')}`);
    }

    if (config.hostForwards.length > 0) {
        console.log('\nPorts:');
        config.hostForwards.forEach((forward, index) => {
            console.log(formatForward(forward, index));
        });
    }
}

function handlePorts(args) {
    const subcommand = args[0];
    const options = parseOptionMap(args.slice(1));
    const config = loadConfig();

    if (subcommand === 'list') {
        if (config.hostForwards.length === 0) {
            console.log('No host forwards configured.');
            return;
        }

        config.hostForwards.forEach((forward, index) => {
            console.log(formatForward(forward, index));
        });
        return;
    }

    if (subcommand === 'add') {
        const forward = {
            protocol: options.protocol || 'tcp',
            hostAddress: ensureOption(options, 'host', 'Missing required option --host.'),
            hostPort: parseIntegerOption(options, 'hport'),
            guestAddress: normalizeForwardGuestAddress(typeof options.guest === 'string' ? options.guest : ''),
            guestPort: parseIntegerOption(options, 'gport'),
        };

        if (!forward.hostPort || !forward.guestPort) {
            fail('Both --hport and --gport are required integer options.');
        }

        const alreadyExists = config.hostForwards.some((item) =>
            (item.protocol || 'tcp') === forward.protocol
            && item.hostAddress === forward.hostAddress
            && Number(item.hostPort) === forward.hostPort
            && normalizeForwardGuestAddress(item.guestAddress) === normalizeForwardGuestAddress(forward.guestAddress)
            && Number(item.guestPort) === forward.guestPort
        );

        if (alreadyExists) {
            console.log('That port forward already exists.');
            return;
        }

        config.hostForwards.push(forward);
        saveConfig(config);
        console.log(`Added port forward: ${formatForward(forward, config.hostForwards.length - 1)}`);
        return;
    }

    if (subcommand === 'remove') {
        const hostAddress = ensureOption(options, 'host', 'Missing required option --host.');
        const hostPort = parseIntegerOption(options, 'hport');
        const protocol = options.protocol || 'tcp';

        if (!hostPort) {
            fail('Missing required option --hport.');
        }

        const beforeCount = config.hostForwards.length;
        config.hostForwards = config.hostForwards.filter((forward) => !(
            (forward.protocol || 'tcp') === protocol
            && forward.hostAddress === hostAddress
            && Number(forward.hostPort) === hostPort
        ));

        if (config.hostForwards.length === beforeCount) {
            fail(`No port forward found for ${protocol} ${hostAddress}:${hostPort}.`);
        }

        saveConfig(config);
        console.log(`Removed ${beforeCount - config.hostForwards.length} port forward(s) for ${protocol} ${hostAddress}:${hostPort}.`);
        return;
    }

    fail('Usage: amino ports <list|add|remove> [...]');
}

function handleDisk(args) {
    const subcommand = args[0];
    const options = parseOptionMap(args.slice(1));

    if (subcommand !== 'resize') {
        fail('Usage: amino disk resize --path <disk> --size <size>');
    }

    if (!options.size && !options.add) {
        fail('Use either --size <size> or --add <size>.');
    }

    resizeDisk({
        diskPath: options.path || options.disk || null,
        setSize: options.size || null,
        addSize: options.add || null,
        backup: !options['no-backup'],
        showInfo: Boolean(options.info),
    });
}

function handleImage(args) {
    const subcommand = args[0];
    const options = parseOptionMap(args.slice(1));
    const config = loadConfig();

    if (subcommand === 'list') {
        const images = listImageFiles();

        if (images.length === 0) {
            console.log(`No disk images or ISOs found in ${runtimeBaseDir}.`);
            return;
        }

        images.forEach((image) => {
            const marker = image.selected ? '*' : ' ';
            console.log(`${marker} [${image.type}] ${image.path}`);
        });
        return;
    }

    if (subcommand === 'select') {
        const imagePath = ensureOption(options, 'path', 'Missing required option --path.');
        const absolutePath = resolveRuntimePath(imagePath);

        if (!fs.existsSync(absolutePath)) {
            fail(`Disk image not found: ${absolutePath}`);
        }

        config.diskPath = toConfigPath(imagePath);
        config.useIso = false;
        saveConfig(config);
        console.log(`Selected disk image: ${config.diskPath}`);
        console.log('Boot source set to disk.');
        return;
    }

    if (subcommand === 'install') {
        const imagePath = ensureOption(options, 'path', 'Missing required option --path.');
        const absolutePath = resolveRuntimePath(imagePath);

        if (!fs.existsSync(absolutePath)) {
            fail(`Install image not found: ${absolutePath}`);
        }

        config.isoPath = toConfigPath(imagePath);
        config.useIso = true;
        saveConfig(config);
        console.log(`Install image selected: ${config.isoPath}`);
        console.log('The next launch will boot from the ISO. Set useIso back to false to return to disk boot later.');
        return;
    }

    fail('Usage: amino image <list|select|install> [...]');
}

function handleBuild(args) {
    const target = args[0];
    if (!target) {
        fail('Usage: amino build <windows|linux|macos>');
    }

    const outputPath = buildForPlatform(target);
    console.log(`Build complete: ${outputPath}`);
}

function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (command === '--help' || command === '-h' || command === 'help') {
        printUsage();
        return;
    }

    if (!command || command === 'launch' || command.startsWith('--')) {
        const launchArgs = command && command.startsWith('--') ? args : args.slice(1);
        handleLaunch(launchArgs);
        return;
    }

    if (command === 'stop') {
        handleStop();
        return;
    }

    if (command === 'status') {
        handleStatus();
        return;
    }

    if (command === 'ports') {
        handlePorts(args.slice(1));
        return;
    }

    if (command === 'disk') {
        handleDisk(args.slice(1));
        return;
    }

    if (command === 'image') {
        handleImage(args.slice(1));
        return;
    }

    if (command === 'build') {
        handleBuild(args.slice(1));
        return;
    }

    fail(`Unknown command: ${command}`);
}

try {
    main();
} catch (error) {
    fail(error.message);
}
