# Tremble

Tremble turns an M5Stack StickS3 into a vibration recorder for students and field checks. The Stick samples its BMI270 accelerometer, hosts a website, and keeps saved captures in flash. Analysis, plots, and file exports run in the browser on that website, so a phone or laptop on the Stick's network is enough.

Recording starts and stops from the website. The buttons on the Stick are not used. Pressing them would shake the sensor and spoil the reading.

## Connect

1. Power the Stick from USB-C or its battery.
2. Join the Wi-Fi network **Tremble**, password **tremble1**.
3. Open **http://192.168.4.1**.

The screen shows the Wi-Fi name, password, 192.168.4.1, tremble.local, and whether a capture is running. Leave the Stick alone while it says REC.

If you also save a lab network on the Capture page, the Stick joins that network and keeps the Tremble network at the same time. On the lab network the page is at `http://tremble.local` when mDNS works, or at the address shown on the screen.

## Measure

Mount the magnetic back on a rigid part of the structure, wait for it to settle, then press **Start** on the website. Presets:

- **Structure**: 400 Hz, ±2 g, 30 s, high-pass 0.3 Hz
- **Machine**: 1600 Hz, ±8 g, 10 s, high-pass 2 Hz
- **Impact**: 1600 Hz, ±16 g, 5 s

The longest capture is 120 seconds at 1600 Hz. Raw samples stay in memory until you save them. Saved `.vibe` files live in the Stick's flash and can be downloaded from the Files page.

## Analyze and export

The Analyze page removes gravity with a high-pass (or by subtracting the mean), then reports:

- RMS, peak, peak-to-peak, and crest factor on each axis and as an RSS
- a Hann spectrum and the strongest peaks
- velocity in mm/s from a single integration
- optional displacement in µm from a second integration

Exports from the browser:

- PNG report with the waveform and spectrum
- CSV of time, raw g, dynamic g, and velocity
- spectrum CSV
- JSON summary
- the original `.vibe` capture

Analyze can remap the sensor axes, smooth with an exponential average, and draw the raw samples under the filtered line. The timeline plays the capture back, or a short window of it. The strongest peak is reported with a half-power damping estimate, and you can set that capture as a baseline for the next one. A CSV of x, y, z in g can be dropped in from another logger.

On Capture, **Log gyroscope** records X, Y, and Z rotation with the acceleration, at ±2000 °/s. The Live page keeps a rolling waveform and a live spectrum.

The live page refreshes the rolling trace about 20 times a second. The trace itself is kept at 100 Hz, and each point holds the strongest sample in that slice so a short shock is still visible. The full sample rate is in the saved capture.

The full charts are the Wi-Fi page. The same start, stop, and settings commands also work over USB serial at 115200 baud, and over Bluetooth under the name Tremble (Nordic UART). The Stick's buttons still do not start a recording.

You can drop a `.vibe` file onto the Analyze page later and process it again.

## Build and flash

From this folder:

```powershell
.\tremble.cmd ports
.\tremble.cmd upload
.\tremble.cmd monitor
```

`upload` compiles if needed, then flashes the StickS3. It will not flash the Tab5 or the other serial devices on this PC. `run` flashes and then opens the serial monitor. `test` checks the vibration math.

If the Stick does not appear in `ports`, put it in bootloader mode by holding the power button for a few seconds, then run `upload` again. After the upload finishes, reboot the Stick by pressing the power button once.

The firmware targets the StickS3: ESP32-S3, 8 MB flash, 8 MB PSRAM, BMI270 on I2C. It is a screening tool. It is not a calibrated laboratory accelerometer, and it cannot see ultrasonic bearing frequencies.

## License

Tremble is released under the [MIT license](LICENSE).
