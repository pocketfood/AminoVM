const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load config
let config;
try {
    config = JSON.parse(fs.readFileSync('config.json'));
} catch (error) {
    console.error('Could not read config.json, using default settings.');
    config = { showConsole: false }; // Default value
}

// Define paths
const qemuPath = path.join('qemu', 'qemu-system-x86_64.exe'); // Relative path to QEMU executable

// Disk Image is for already finished distros, iso is if you want to install a new image.
// Remeber if you plan on installing a new image you need to have a blank .img file using (qemu-img create -f qcow2 c://path//to/file.img 20G)

const imgPath = path.resolve('deb.img'); // Absolute path to disk image
const isoPath = path.resolve('debian-13.3.0-amd64-netinst.iso'); // Absolute path to ISO

// Name for the title
const vmName = 'AminoVM';

function launchVM() {
    // Check if QEMU executable exists
    if (!fs.existsSync(qemuPath)) {
        console.error(`QEMU executable not found at ${qemuPath}`);
        return; // Exit if the executable isn't found
    }

    console.log(`Using QEMU Path: ${qemuPath}`);
    console.log(`Using Disk Image Path: ${imgPath}`);
    console.log(`Using ISO Path: ${isoPath}`); // Log the ISO path

    // Define the arguments for the QEMU process
    const args = [
        '-m', '8192',
        '-smp', '8',
        '-hda', imgPath,
        '-cdrom', isoPath, // Include the ISO argument
        '-boot', 'd', 
        '-net', 'nic',
        '-net', 'user,hostfwd=tcp::8080-:9090,hostfwd=tcp::22-:22',
        '-name', vmName,
    ];

    // If showConsole is false, set the window to hidden
    const spawnOptions = config.showConsole ? { shell: true } : { detached: true, stdio: 'ignore' };

    const qemuProcess = spawn(qemuPath, args, spawnOptions);

    // Handle stdout and stderr from QEMU
    if (config.showConsole) {
        qemuProcess.stdout.on('data', (data) => {
            console.log(`Output: ${data}`);
        });

        qemuProcess.stderr.on('data', (data) => {
            console.error(`Error: ${data}`);
        });
    }

    qemuProcess.on('close', (code) => {
        console.log(`QEMU process exited with code ${code}`);
    });
}

// Call the function to launch the VM
launchVM();
