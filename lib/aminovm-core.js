const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const runtimeBaseDir = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const configPath = path.join(runtimeBaseDir, 'config.json');
const logPath = path.join(runtimeBaseDir, 'launcher.log');
const pidFilePath = path.join(runtimeBaseDir, '.aminovm.pid.json');
const powershellPath = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
const vmName = 'AminoVM';

const defaultConfig = {
    showConsole: false,
    memoryMB: 12288,
    cpus: 12,
    diskPath: 'deb.img',
    diskFormat: 'qcow2',
    useIso: false,
    isoPath: 'debian-13.3.0-amd64-netinst.iso',
    compatMode: false,
    machine: 'pc',
    display: 'sdl',
    accel: 'whpx',
    cpu: 'max',
    networkDevice: '',
    videoDevice: '',
    inputDevices: [],
    hostForwards: [
        { protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: 443, guestPort: 443 },
        { protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: 9090, guestPort: 9090 },
        { protocol: 'tcp', hostAddress: '127.0.0.1', hostPort: 2222, guestPort: 22 },
    ],
    vnc: {
        enabled: true,
        address: '127.0.0.1',
        display: 1,
    },
    tray: {
        enabled: false,
        tooltip: vmName,
        cockpitUrl: '',
    },
};

function writeLog(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    fs.appendFileSync(logPath, `${line}\n`);
    console.log(line);
}

function readPidFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(pidFilePath, 'utf8'));
        const pid = Number(parsed?.pid);
        return Number.isInteger(pid) && pid > 0 ? { pid } : null;
    } catch (error) {
        return null;
    }
}

function writePidFile(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return;
    }

    fs.writeFileSync(
        pidFilePath,
        `${JSON.stringify({ pid, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8'
    );
}

function removePidFile() {
    if (fs.existsSync(pidFilePath)) {
        fs.unlinkSync(pidFilePath);
    }
}

function isPidRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function getExpectedQemuPaths() {
    const executableNames = process.platform === 'win32'
        ? ['qemu-system-x86_64w.exe', 'qemu-system-x86_64.exe']
        : ['qemu-system-x86_64'];

    return executableNames
        .map((executableName) => path.join(runtimeBaseDir, 'qemu', executableName).toLowerCase());
}

function isExpectedQemuProcessName(processName) {
    const normalizedName = String(processName || '').trim().toLowerCase();
    return normalizedName === 'qemu-system-x86_64w.exe'
        || normalizedName === 'qemu-system-x86_64w'
        || normalizedName === 'qemu-system-x86_64.exe'
        || normalizedName === 'qemu-system-x86_64';
}

function getWindowsProcessInfoByPid(pid) {
    const command = [
        `$process = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
        "if (-not $process) { 'null' } else {",
        '    [pscustomobject]@{',
        '        ProcessId = $process.Id;',
        '        Name = "$($process.ProcessName).exe";',
        '        Path = $process.Path',
        '    } | ConvertTo-Json -Compress',
        '}',
    ].join('; ');

    const result = spawnSync(
        powershellPath,
        ['-NoProfile', '-Command', command],
        {
            cwd: runtimeBaseDir,
            windowsHide: true,
            encoding: 'utf8',
        },
    );

    if (result.error || result.status !== 0) {
        return {
            pid,
            name: '',
            path: '',
            unverified: true,
        };
    }

    try {
        const parsed = JSON.parse(String(result.stdout || '').trim() || 'null');
        if (!parsed) {
            return null;
        }

        return {
            pid: Number(parsed.ProcessId),
            name: parsed.Name || '',
            path: parsed.Path || '',
        };
    } catch (error) {
        return null;
    }
}

function getUnixProcessArgsByPid(pid) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], {
        cwd: runtimeBaseDir,
        encoding: 'utf8',
    });

    if (result.error || result.status !== 0) {
        return '';
    }

    return String(result.stdout || '').trim();
}

function isTrackedQemuPid(pid) {
    if (!isPidRunning(pid)) {
        return false;
    }

    if (process.platform === 'win32') {
        const processInfo = getWindowsProcessInfoByPid(pid);
        if (processInfo?.unverified) {
            return true;
        }

        if (!processInfo || !isExpectedQemuProcessName(processInfo.name)) {
            return false;
        }

        const processPath = String(processInfo.path || '').toLowerCase();
        return processPath === '' || getExpectedQemuPaths().includes(processPath);
    }

    const processArgs = getUnixProcessArgsByPid(pid);
    return processArgs.includes('-name AminoVM') && isExpectedQemuProcessName(path.basename(processArgs.split(/\s+/)[0]));
}

function getTrackedVmProcess() {
    const pidInfo = readPidFile();
    if (!pidInfo) {
        return null;
    }

    if (!isTrackedQemuPid(pidInfo.pid)) {
        writeLog(`Ignoring stale ${vmName} pid file for PID ${pidInfo.pid}; it is not a matching QEMU process.`);
        removePidFile();
        return null;
    }

    return pidInfo;
}

function resolveRuntimePath(targetPath) {
    return path.isAbsolute(targetPath) ? targetPath : path.resolve(runtimeBaseDir, targetPath);
}

function toConfigPath(targetPath) {
    const absolutePath = resolveRuntimePath(targetPath);
    const relativePath = path.relative(runtimeBaseDir, absolutePath);

    if (
        relativePath !== ''
        && !relativePath.startsWith('..')
        && !path.isAbsolute(relativePath)
    ) {
        return relativePath.replace(/\\/g, '/');
    }

    if (relativePath === '') {
        return '.';
    }

    return absolutePath;
}

function toPowerShellSingleQuoted(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function mergeConfig(userConfig = {}) {
    return {
        ...defaultConfig,
        ...userConfig,
        hostForwards: Array.isArray(userConfig.hostForwards)
            ? userConfig.hostForwards
            : defaultConfig.hostForwards.map((forward) => ({ ...forward })),
        vnc: { ...defaultConfig.vnc, ...(userConfig.vnc || {}) },
        tray: { ...defaultConfig.tray, ...(userConfig.tray || {}) },
    };
}

function applyConfigOverrides(baseConfig, overrides = {}) {
    const nextConfig = {
        ...baseConfig,
        ...overrides,
        vnc: { ...(baseConfig.vnc || {}), ...(overrides.vnc || {}) },
        tray: { ...(baseConfig.tray || {}), ...(overrides.tray || {}) },
    };

    if (overrides.hostForwards) {
        nextConfig.hostForwards = overrides.hostForwards;
    }

    return nextConfig;
}

function loadConfig() {
    try {
        const rawConfig = fs.readFileSync(configPath, 'utf8');
        return mergeConfig(JSON.parse(rawConfig));
    } catch (error) {
        writeLog(`Could not read config.json from ${configPath}, using default settings. ${error.message}`);
        return mergeConfig();
    }
}

function saveConfig(config) {
    const mergedConfig = mergeConfig(config);
    fs.writeFileSync(configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, 'utf8');
    return mergedConfig;
}

function buildHostForwardArg(forward) {
    const protocol = forward.protocol || 'tcp';
    const hostPort = Number(forward.hostPort);
    const guestPort = Number(forward.guestPort);

    if (!Number.isInteger(hostPort) || !Number.isInteger(guestPort)) {
        writeLog(`Skipping invalid host forward entry: ${JSON.stringify(forward)}`);
        return null;
    }

    const hostPart = forward.hostAddress ? `${forward.hostAddress}:${hostPort}` : `:${hostPort}`;
    const guestAddress = typeof forward.guestAddress === 'string'
        ? forward.guestAddress.trim()
        : '';
    const normalizedGuestAddress = guestAddress.toLowerCase();
    const guestUsesDefaultSlirpAddress = guestAddress === ''
        || normalizedGuestAddress === 'guest'
        || normalizedGuestAddress === 'default'
        || guestAddress === '10.0.2.15';
    const guestPart = guestUsesDefaultSlirpAddress ? `:${guestPort}` : `${guestAddress}:${guestPort}`;
    return `hostfwd=${protocol}:${hostPart}-${guestPart}`;
}

function displayUsesGuiWindow(display) {
    const normalizedDisplay = String(display || '').trim().toLowerCase();
    return normalizedDisplay !== ''
        && !normalizedDisplay.startsWith('none')
        && !normalizedDisplay.startsWith('egl-headless')
        && !normalizedDisplay.startsWith('curses');
}

function resolveQemuPath(config) {
    const consoleBinary = process.platform === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';
    const guiBinary = process.platform === 'win32' ? 'qemu-system-x86_64w.exe' : consoleBinary;
    const consolePath = path.join(runtimeBaseDir, 'qemu', consoleBinary);
    const guiPath = path.join(runtimeBaseDir, 'qemu', guiBinary);

    if (process.platform === 'win32' && displayUsesGuiWindow(config.display) && fs.existsSync(guiPath)) {
        return guiPath;
    }

    return consolePath;
}

function resolveConsoleQemuPath() {
    return path.join(runtimeBaseDir, 'qemu', process.platform === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64');
}

function resolveQemuImgPath() {
    return path.join(runtimeBaseDir, 'qemu', process.platform === 'win32' ? 'qemu-img.exe' : 'qemu-img');
}

function resolveNetworkDevice(config) {
    if (typeof config.networkDevice === 'string' && config.networkDevice.trim() !== '') {
        return config.networkDevice.trim();
    }

    return config.compatMode ? 'rtl8139' : 'virtio-net-pci';
}

function resolveVideoArgs(config) {
    const configuredVideoDevice = typeof config.videoDevice === 'string'
        ? config.videoDevice.trim()
        : '';

    if (!configuredVideoDevice) {
        return config.compatMode
            ? ['-vga', 'std']
            : ['-device', 'virtio-vga'];
    }

    const normalizedVideoDevice = configuredVideoDevice.toLowerCase();
    const legacyVgaModels = new Set(['std', 'cirrus', 'vmware', 'qxl', 'none']);

    return legacyVgaModels.has(normalizedVideoDevice)
        ? ['-vga', configuredVideoDevice]
        : ['-device', configuredVideoDevice];
}

function buildDefaultCockpitUrl(config) {
    const cockpitForward = (Array.isArray(config.hostForwards) ? config.hostForwards : [])
        .find((forward) => (forward.protocol || 'tcp') === 'tcp' && Number(forward.hostPort) === 9090);

    if (!cockpitForward) {
        return 'https://127.0.0.1:9090';
    }

    const normalizedHost = String(cockpitForward.hostAddress || '').trim().toLowerCase();
    const localHost = normalizedHost === '' || normalizedHost === '0.0.0.0' || normalizedHost === '::'
        ? '127.0.0.1'
        : cockpitForward.hostAddress;

    return `https://${localHost}:${Number(cockpitForward.hostPort)}`;
}

function buildTrayPowerShellScript(pid, config) {
    const trayConfig = config.tray || {};
    const tooltip = String(trayConfig.tooltip || vmName).slice(0, 63);
    const cockpitUrl = String(trayConfig.cockpitUrl || buildDefaultCockpitUrl(config) || '').trim();

    return [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '[System.Windows.Forms.Application]::EnableVisualStyles()',
        `$vmName = ${toPowerShellSingleQuoted(vmName)}`,
        `$vmPid = ${Number(pid)}`,
        `$pidFile = ${toPowerShellSingleQuoted(pidFilePath)}`,
        `$tooltip = ${toPowerShellSingleQuoted(tooltip)}`,
        `$cockpitUrl = ${toPowerShellSingleQuoted(cockpitUrl)}`,
        '$notifyIcon = New-Object System.Windows.Forms.NotifyIcon',
        '$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application',
        '$notifyIcon.Text = $tooltip',
        '$menu = New-Object System.Windows.Forms.ContextMenuStrip',
        '$script:shutdownTray = {',
        '    if ($timer) { $timer.Stop() }',
        '    $notifyIcon.Visible = $false',
        '    $notifyIcon.Dispose()',
        '    [System.Windows.Forms.Application]::Exit()',
        '}',
        'if ($cockpitUrl) {',
        "    $openItem = $menu.Items.Add('Open Cockpit')",
        '    $openItem.add_Click({ Start-Process $cockpitUrl })',
        '}',
        'if ($menu.Items.Count -gt 0) { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }',
        "    $stopItem = $menu.Items.Add('Stop VM')",
        '    $stopItem.add_Click({',
        '        try { Stop-Process -Id $vmPid -Force -ErrorAction Stop } catch {}',
        '        try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue } catch {}',
        '    })',
        "    $exitItem = $menu.Items.Add('Exit Tray')",
        '    $exitItem.add_Click($script:shutdownTray)',
        '$notifyIcon.ContextMenuStrip = $menu',
        '$notifyIcon.Visible = $true',
        'if ($cockpitUrl) {',
        '    $notifyIcon.add_DoubleClick({ Start-Process $cockpitUrl })',
        '}',
        '$notifyIcon.BalloonTipTitle = $vmName',
        "$notifyIcon.BalloonTipText = \"$vmName is running in the system tray.\"",
        '$notifyIcon.ShowBalloonTip(2500)',
        '$timer = New-Object System.Windows.Forms.Timer',
        '$timer.Interval = 3000',
        '$timer.add_Tick({',
        '    if (-not (Get-Process -Id $vmPid -ErrorAction SilentlyContinue)) {',
        '        try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue } catch {}',
        '        & $script:shutdownTray',
        '    }',
        '})',
        '$timer.Start()',
        '[System.Windows.Forms.Application]::Run()',
    ].join('; ');
}

function startTrayHelper(pid, config) {
    if (!Number.isInteger(pid) || pid <= 0 || process.platform !== 'win32' || !config.tray?.enabled) {
        return false;
    }

    const encodedScript = Buffer
        .from(buildTrayPowerShellScript(pid, config), 'utf16le')
        .toString('base64');
    const trayProcess = spawn(
        powershellPath,
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Sta', '-EncodedCommand', encodedScript],
        {
            cwd: runtimeBaseDir,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        },
    );

    trayProcess.on('error', (error) => {
        writeLog(`Failed to launch tray helper: ${error.message}`);
    });
    trayProcess.unref();
    return true;
}

function sleepSync(milliseconds) {
    if (!Number.isInteger(milliseconds) || milliseconds <= 0) {
        return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertLaunchedProcessIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('QEMU launch did not return a process ID.');
    }

    sleepSync(750);

    if (!isTrackedQemuPid(pid)) {
        removePidFile();
        throw new Error(`QEMU process ${pid} exited immediately after launch. Check launcher.log and try a conservative display such as "sdl".`);
    }
}

function buildQemuArgs(config) {
    const qemuPath = resolveQemuPath(config);
    const imgPath = resolveRuntimePath(config.diskPath);
    const isoPath = resolveRuntimePath(config.isoPath);
    const networkDevice = resolveNetworkDevice(config);
    const hostForwardArgs = (Array.isArray(config.hostForwards) ? config.hostForwards : [])
        .map(buildHostForwardArg)
        .filter(Boolean);
    const inputDeviceArgs = (Array.isArray(config.inputDevices) ? config.inputDevices : [])
        .filter((deviceName) => typeof deviceName === 'string' && deviceName.trim() !== '')
        .flatMap((deviceName) => ['-device', deviceName.trim()]);

    const diskArg = config.compatMode
        ? `file=${imgPath},if=ide,format=${config.diskFormat},cache=writeback`
        : `file=${imgPath},if=virtio,format=${config.diskFormat},cache=writeback,discard=unmap`;

    const videoArgs = resolveVideoArgs(config);

    const args = [
        '-accel', config.accel,
        '-machine', config.machine,
        '-cpu', config.cpu,
        '-m', String(config.memoryMB),
        '-smp', String(config.cpus),
        '-drive', diskArg,
        ...(config.useIso ? ['-cdrom', isoPath] : []),
        '-boot', config.useIso ? 'd' : 'c',
        '-netdev', ['user,id=net0', ...hostForwardArgs].join(','),
        '-device', `${networkDevice},netdev=net0`,
        ...videoArgs,
        ...inputDeviceArgs,
        '-display', config.display,
        ...(config.vnc?.enabled ? ['-vnc', `${config.vnc.address}:${config.vnc.display}`] : []),
        '-name', vmName,
    ];

    return {
        args,
        hostForwardArgs,
        imgPath,
        isoPath,
        networkDevice,
        qemuPath,
    };
}

function validateAcceleration(config) {
    const normalizedAccel = String(config.accel || '').trim().toLowerCase();
    if (!normalizedAccel.startsWith('whpx')) {
        return;
    }

    const qemuPath = resolveConsoleQemuPath();
    const probeArgs = ['-accel', config.accel, '-machine', 'none', '-nodefaults', '-display', 'none', '-S'];
    const result = spawnSync(qemuPath, probeArgs, {
        cwd: runtimeBaseDir,
        windowsHide: true,
        encoding: 'utf8',
    });

    if (result.error) {
        throw new Error(`Failed to probe ${config.accel}: ${result.error.message}`);
    }

    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim() || `QEMU exited with status ${result.status}.`;
        throw new Error(`QEMU acceleration '${config.accel}' is unavailable on this host. ${detail}`);
    }
}

function launchVM(overrides = {}) {
    const trackedProcess = getTrackedVmProcess();
    if (trackedProcess) {
        writeLog(`Launch skipped because ${vmName} is already running (PID ${trackedProcess.pid}) from pid file.`);
        return {
            pid: trackedProcess.pid,
            pids: [trackedProcess.pid],
            alreadyRunning: true,
        };
    }

    const runningProcesses = findVmProcesses();
    if (runningProcesses.length > 0) {
        const pids = runningProcesses.map((processInfo) => processInfo.pid).filter((pid) => pid > 0);
        if (pids.length > 0) {
            writePidFile(pids[0]);
        }
        writeLog(`Launch skipped because ${vmName} is already running${pids.length > 0 ? ` (PID ${pids.join(', ')})` : ''}.`);
        return {
            pid: pids[0] || 0,
            pids,
            alreadyRunning: true,
        };
    }

    const baseConfig = loadConfig();
    const config = applyConfigOverrides(baseConfig, overrides);
    const {
        args,
        hostForwardArgs,
        imgPath,
        isoPath,
        networkDevice,
        qemuPath,
    } = buildQemuArgs(config);
    validateAcceleration(config);

    if (!fs.existsSync(qemuPath)) {
        throw new Error(`QEMU executable not found at ${qemuPath}`);
    }

    writeLog(`Using QEMU Path: ${qemuPath}`);
    if (process.platform === 'win32' && qemuPath.endsWith('qemu-system-x86_64w.exe')) {
        writeLog('Using the GUI QEMU binary so the VM display stays in the normal QEMU window.');
    }

    if (!fs.existsSync(imgPath)) {
        throw new Error(`Disk image not found at ${imgPath}`);
    }

    if (config.useIso && !fs.existsSync(isoPath)) {
        throw new Error(`ISO not found at ${isoPath}`);
    }

    writeLog(`Using Disk Image Path: ${imgPath}`);
    if (config.useIso) {
        writeLog(`Using ISO Path: ${isoPath}`);
    }

    if (hostForwardArgs.length > 0) {
        writeLog(`Host forwards: ${hostForwardArgs.join(', ')}`);
    }

    writeLog(`Network device: ${networkDevice}`);
    if (config.vnc?.enabled) {
        writeLog(`VNC available at ${config.vnc.address}:${5900 + Number(config.vnc.display)}`);
    }
    writeLog(`QEMU args: ${args.join(' ')}`);

    if (process.platform === 'win32') {
        const argList = args.map(toPowerShellSingleQuoted).join(', ');
        const shouldHideQemuProcessWindow = !displayUsesGuiWindow(config.display);
        const command = [
            `$argList = @(${argList})`,
            `$startArgs = @{ FilePath = ${toPowerShellSingleQuoted(qemuPath)}; ArgumentList = $argList; WorkingDirectory = ${toPowerShellSingleQuoted(runtimeBaseDir)}; PassThru = $true }`,
            ...(shouldHideQemuProcessWindow ? ["$startArgs.WindowStyle = 'Hidden'"] : []),
            '$process = Start-Process @startArgs',
            'Write-Output $process.Id',
        ].join('; ');

        const result = spawnSync(
            powershellPath,
            ['-NoProfile', '-Command', command],
            {
                cwd: runtimeBaseDir,
                windowsHide: !config.showConsole,
                encoding: 'utf8',
            },
        );

        if (result.error) {
            throw new Error(`Failed to launch QEMU via Start-Process: ${result.error.message}`);
        }

        if (result.status !== 0) {
            throw new Error(
                `Start-Process failed with exit code ${result.status}. ${result.stderr?.trim() || result.stdout?.trim() || 'No output.'}`
            );
        }

        const pid = Number(result.stdout.trim() || 0);
        assertLaunchedProcessIsAlive(pid);
        writePidFile(pid);
        writeLog(`QEMU launch requested with PID ${pid || 'unknown'}`);
        writeLog('QEMU was launched with Windows Start-Process so it can outlive the launcher.');
        if (startTrayHelper(pid, config)) {
            writeLog(`Tray helper started for ${vmName}.`);
        }

        if (config.showConsole) {
            writeLog('The launcher console can be closed without stopping QEMU.');
            if (String(config.display).startsWith('none')) {
                writeLog('Use VNC at 127.0.0.1:5901 for the VM desktop when display is set to none.');
            } else {
                writeLog(`QEMU display mode: ${config.display}`);
            }
            setInterval(() => {}, 1000);
        }

        return { pid, pids: pid ? [pid] : [], alreadyRunning: false };
    }

    const qemuProcess = spawn(qemuPath, args, {
        cwd: runtimeBaseDir,
        detached: !config.showConsole,
        stdio: config.showConsole ? 'inherit' : 'ignore',
    });

    qemuProcess.on('error', (error) => {
        writeLog(`Failed to launch QEMU: ${error.message}`);
    });

    if (!config.showConsole) {
        qemuProcess.unref();
    }

    writePidFile(qemuProcess.pid || 0);
    writeLog(`QEMU launch requested with PID ${qemuProcess.pid || 'unknown'}`);
    return {
        pid: qemuProcess.pid || 0,
        pids: qemuProcess.pid ? [qemuProcess.pid] : [],
        alreadyRunning: false,
    };
}

function parseJsonOutput(rawValue) {
    const trimmed = String(rawValue || '').trim();
    if (!trimmed) {
        return [];
    }

    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
}

function parseTasklistCsv(rawValue) {
    const lines = String(rawValue || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (lines.length <= 1 || lines[0].startsWith('INFO:')) {
        return [];
    }

    const records = [];
    for (let index = 1; index < lines.length; index += 1) {
        const parts = lines[index].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => part.replace(/^"|"$/g, ''));
        if (parts.length < 2) {
            continue;
        }

        records.push({
            name: parts[0],
            pid: Number(parts[1]),
            windowTitle: parts[8] || '',
        });
    }

    return records;
}

function findVmProcessesViaTasklist() {
    const imageNames = ['qemu-system-x86_64w.exe', 'qemu-system-x86_64.exe'];

    return imageNames.flatMap((imageName) => {
        const result = spawnSync(
            'tasklist',
            ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/V'],
            {
                cwd: runtimeBaseDir,
                windowsHide: true,
                encoding: 'utf8',
            },
        );

        if (result.error || result.status !== 0) {
            return [];
        }

        return parseTasklistCsv(result.stdout)
            .filter((processInfo) => processInfo.pid > 0)
            .map((processInfo) => ({
                pid: processInfo.pid,
                name: processInfo.name,
                commandLine: processInfo.windowTitle,
            }));
    });
}

function findVmProcessesViaGetProcess() {
    const qemuPaths = [
        path.join(runtimeBaseDir, 'qemu', 'qemu-system-x86_64w.exe'),
        path.join(runtimeBaseDir, 'qemu', 'qemu-system-x86_64.exe'),
    ].map((targetPath) => targetPath.toLowerCase());

    const command = [
        `$expectedPaths = @(${qemuPaths.map(toPowerShellSingleQuoted).join(', ')})`,
        '$matches = @()',
        "foreach ($name in @('qemu-system-x86_64w', 'qemu-system-x86_64')) {",
        '    foreach ($process in @(Get-Process $name -ErrorAction SilentlyContinue)) {',
        '        $processPath = if ($process.Path) { $process.Path.ToLowerInvariant() } else { $null }',
        '        if ($processPath -and $expectedPaths -contains $processPath) {',
        "            $matches += [pscustomobject]@{ ProcessId = $process.Id; Name = \"$($process.ProcessName).exe\"; CommandLine = $process.Path }",
        '        }',
        '    }',
        '}',
        "if ($matches.Count -eq 0) { '[]' } else { $matches | ConvertTo-Json -Compress }",
    ].join('; ');

    const result = spawnSync(
        powershellPath,
        ['-NoProfile', '-Command', command],
        {
            cwd: runtimeBaseDir,
            windowsHide: true,
            encoding: 'utf8',
        },
    );

    if (result.error || result.status !== 0) {
        return [];
    }

    return parseJsonOutput(result.stdout).map((processInfo) => ({
        pid: Number(processInfo.ProcessId),
        name: processInfo.Name,
        commandLine: processInfo.CommandLine || '',
    }));
}

function findVmProcesses() {
    const trackedProcess = getTrackedVmProcess();
    const trackedProcessInfo = trackedProcess
        ? {
            pid: trackedProcess.pid,
            name: path.basename(resolveQemuPath(loadConfig())),
            commandLine: `${pidFilePath} -> ${trackedProcess.pid}`,
        }
        : null;

    if (process.platform === 'win32') {
        const processMatches = findVmProcessesViaGetProcess();
        if (processMatches.length > 0) {
            return processMatches;
        }

        const command = [
            '$processes = @(Get-CimInstance Win32_Process | Where-Object {',
            "    ($_.Name -like 'qemu-system-x86_64*') -and ($_.CommandLine -like '*-name AminoVM*')",
            '} | Select-Object ProcessId, Name, CommandLine)',
            "if ($processes.Count -eq 0) { '[]' } else { $processes | ConvertTo-Json -Compress }",
        ].join('; ');

        const result = spawnSync(
            powershellPath,
            ['-NoProfile', '-Command', command],
            {
                cwd: runtimeBaseDir,
                windowsHide: true,
                encoding: 'utf8',
            },
        );

        if (result.error) {
            const tasklistProcesses = findVmProcessesViaTasklist();
            return tasklistProcesses.length > 0
                ? tasklistProcesses
                : (trackedProcessInfo ? [trackedProcessInfo] : []);
        }

        if (result.status !== 0) {
            const tasklistProcesses = findVmProcessesViaTasklist();
            return tasklistProcesses.length > 0
                ? tasklistProcesses
                : (trackedProcessInfo ? [trackedProcessInfo] : []);
        }

        const cimProcesses = parseJsonOutput(result.stdout).map((processInfo) => ({
            pid: Number(processInfo.ProcessId),
            name: processInfo.Name,
            commandLine: processInfo.CommandLine || '',
        }));

        if (cimProcesses.length > 0) {
            return cimProcesses;
        }

        const tasklistProcesses = findVmProcessesViaTasklist();
        return tasklistProcesses.length > 0
            ? tasklistProcesses
            : (trackedProcessInfo ? [trackedProcessInfo] : []);
    }

    const result = spawnSync('ps', ['-eo', 'pid=,args='], {
        cwd: runtimeBaseDir,
        encoding: 'utf8',
    });

    if (result.error) {
        throw new Error(`Failed to query QEMU processes: ${result.error.message}`);
    }

    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Failed to query QEMU processes.');
    }

    const unixProcesses = String(result.stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const match = line.match(/^(\d+)\s+(.*)$/);
            if (!match) {
                return null;
            }

            return {
                pid: Number(match[1]),
                name: path.basename(match[2].split(/\s+/)[0]),
                commandLine: match[2],
            };
        })
        .filter((processInfo) => processInfo && processInfo.commandLine.includes('-name AminoVM'));

    return unixProcesses.length > 0
        ? unixProcesses
        : (trackedProcessInfo ? [trackedProcessInfo] : []);
}

function stopVM() {
    const processes = findVmProcesses();

    if (processes.length === 0) {
        return [];
    }

    if (process.platform === 'win32') {
        const ids = processes.map((processInfo) => processInfo.pid).join(',');
        let result = spawnSync(
            powershellPath,
            ['-NoProfile', '-Command', `Stop-Process -Id ${ids} -Force`],
            {
                cwd: runtimeBaseDir,
                windowsHide: true,
                encoding: 'utf8',
            },
        );

        if (result.error || result.status !== 0) {
            result = spawnSync(
                'taskkill',
                [...processes.flatMap((processInfo) => ['/PID', String(processInfo.pid)]), '/F'],
                {
                    cwd: runtimeBaseDir,
                    windowsHide: true,
                    encoding: 'utf8',
                },
            );
        }

        if (result.error) {
            throw new Error(`Failed to stop QEMU: ${result.error.message}`);
        }

        if (result.status !== 0) {
            throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Failed to stop QEMU.');
        }

        removePidFile();
        return processes;
    }

    processes.forEach((processInfo) => {
        process.kill(processInfo.pid, 'SIGTERM');
    });

    removePidFile();
    return processes;
}

function listImageFiles() {
    const config = loadConfig();
    const selectedDisk = resolveRuntimePath(config.diskPath);
    const selectedIso = resolveRuntimePath(config.isoPath);
    const diskExtensions = new Set(['.img', '.qcow', '.qcow2', '.raw', '.vdi', '.vhd', '.vhdx', '.vmdk']);
    const isoExtensions = new Set(['.iso']);

    return fs.readdirSync(runtimeBaseDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const absolutePath = path.join(runtimeBaseDir, entry.name);
            const extension = path.extname(entry.name).toLowerCase();
            const type = isoExtensions.has(extension)
                ? 'iso'
                : diskExtensions.has(extension)
                    ? 'disk'
                    : null;

            if (!type) {
                return null;
            }

            return {
                path: entry.name,
                absolutePath,
                type,
                selected: type === 'disk'
                    ? absolutePath === selectedDisk
                    : absolutePath === selectedIso && config.useIso,
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.path.localeCompare(right.path));
}

function resolvePkgExecutable() {
    if (process.platform === 'win32') {
        const localPkg = path.join(runtimeBaseDir, 'node_modules', '.bin', 'pkg.cmd');
        return fs.existsSync(localPkg) ? localPkg : 'pkg.cmd';
    }

    const localPkg = path.join(runtimeBaseDir, 'node_modules', '.bin', 'pkg');
    return fs.existsSync(localPkg) ? localPkg : 'pkg';
}

function buildForPlatform(targetName) {
    const buildTargets = {
        windows: { target: 'node14-win-x64', output: 'aminovm.exe', extraArgs: ['--win-console=true'] },
        linux: { target: 'node14-linux-x64', output: 'aminovm-linux-x64', extraArgs: [] },
        macos: { target: 'node14-macos-x64', output: 'aminovm-macos-x64', extraArgs: [] },
    };

    const buildTarget = buildTargets[targetName];
    if (!buildTarget) {
        throw new Error(`Unknown build target "${targetName}". Use windows, linux, or macos.`);
    }

    const pkgExecutable = resolvePkgExecutable();
    const pkgArgs = ['.', '--targets', buildTarget.target, '--output', buildTarget.output, '--debug', ...buildTarget.extraArgs];
    const result = process.platform === 'win32' && pkgExecutable.endsWith('.cmd')
        ? spawnSync(
            'cmd.exe',
            ['/c', pkgExecutable, ...pkgArgs],
            {
                cwd: runtimeBaseDir,
                stdio: 'inherit',
            },
        )
        : spawnSync(
            pkgExecutable,
            pkgArgs,
            {
                cwd: runtimeBaseDir,
                stdio: 'inherit',
                shell: process.platform === 'win32' && !pkgExecutable.endsWith('.cmd'),
            },
        );

    if (result.error) {
        throw new Error(`Failed to build ${targetName}: ${result.error.message}`);
    }

    if (result.status !== 0) {
        throw new Error(`Build failed for ${targetName} with exit code ${result.status}.`);
    }

    return path.join(runtimeBaseDir, buildTarget.output);
}

module.exports = {
    applyConfigOverrides,
    buildForPlatform,
    buildHostForwardArg,
    buildQemuArgs,
    configPath,
    defaultConfig,
    displayUsesGuiWindow,
    findVmProcesses,
    launchVM,
    listImageFiles,
    loadConfig,
    logPath,
    pidFilePath,
    resolveQemuImgPath,
    resolveRuntimePath,
    runtimeBaseDir,
    saveConfig,
    stopVM,
    toConfigPath,
    vmName,
    writeLog,
};
