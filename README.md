# JumpCam

Measure your standing vertical jump from a video. JumpCam uses AI pose detection (MediaPipe Pose Landmarker) to track your hips, knees, and feet frame by frame, then turns the hip rise into centimeters using your height as a ruler.

**Everything runs on your phone.** The video is never uploaded anywhere. Saved results stay in your browser.

Works in Chrome on Android and Safari on iPhone, and installs to the home screen as an app (PWA). After the first analysis, it works offline.

## Screenshots

| Welcome | How to record | Home | Result | History |
| --- | --- | --- | --- | --- |
| _(add screenshot)_ | _(add screenshot)_ | _(add screenshot)_ | _(add screenshot)_ | _(add screenshot)_ |

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout for all screens |
| `style.css` | Design, light and dark mode |
| `app.js` | Everything else: setup, guide, pose detection, measurement, results, history |
| `sw.js` | Service worker: saves the app, AI library, and model for offline use |
| `manifest.json` | Lets the app be installed to the home screen |
| `icon.svg`, `icon-512.png` | App icons |

No build step. The AI library loads from the jsDelivr CDN and the model from Google's MediaPipe model storage.

## How the measurement works

The steps are numbered the same way in the comments in `app.js` (section 9, `measureJump`).

1. **Pose detection on every frame.** The app finds the video's frame rate by playing a moment in slow motion and reading each frame's exact time with `requestVideoFrameCallback`. It then seeks to each frame, scales it to 960 px, and runs `detectForVideo` with increasing timestamps. For each frame it stores the time, the 33 landmarks with visibility scores, and the top of the person from the segmentation mask.
2. **Pick the side.** It uses the left or right landmarks (hip, knee, ankle, heel, toe), whichever are more visible on average.
3. **Smooth.** A small moving average (3 frames, or 5 at 90 fps and above) reduces jitter.
4. **Calibrate.** It finds the earliest still standing moment. The floor is the resting level of the heel and toe, and body height in pixels runs from the top of the segmentation mask to the floor. Scale = your height in cm ÷ body height in pixels.
5. **Takeoff and landing.** Takeoff is the first frame where the toe is more than 3 cm above the floor and stays up for 3 frames. Landing is where it comes back down and stays down.
6. **Peak.** The frame between takeoff and landing where the hip is highest.
7. **Main result: hip rise.** This is the hip rise from takeoff to peak, in cm. The first frame "in the air" is caught slightly after the real takeoff (at 30 fps the feet can rise up to 10 cm between frames), so the toe's lift at that frame is added back. With straight legs, the hip and toe rise together. The frame rate doesn't affect this method.
8. **Secondary result.** Toe height above the floor at the peak.
9. **Slow-motion detection.** Physics gives the real flight time for a jump of height h: t = √(8h / 9.81). Comparing it with the flight time in the video gives the slow-motion factor. About 1 means normal speed. About 2, 4, or 8 means "Slow motion detected (about Nx)", and the flight time is corrected.

### Form checks

- **Knee angle at the peak** under 160°: legs bent in the air, so the result may be too high.
- **Hip moved more than 12 cm sideways** during the jump.
- **Hip and toe results disagree** by more than 5 cm or 20%: lower confidence.
- **Problems the user must fix** show a clear error with a link to the recording guide: no person found, low visibility, head or feet cut off, body too small in the frame, no still standing at the start, no jump, or no landing found.
- **Confidence** is High, Medium, or Low, based on the number of warnings.

## Accuracy

These results are estimates. Accuracy is about plus or minus 2-3 cm with a steady camera and good form. The main error sources are:

- **Your entered height.** A 2 cm error in height gives about a 1% error in the result.
- **Bent legs or flexed feet in the air.** This changes the hip-to-toe distance.
- **Moving toward or away from the camera.** This changes the scale.
- **Low frame rate.** At 30 fps the feet move up to 10 cm between frames. The takeoff correction handles most of this, but slow motion is more precise.
- **Baggy clothes.** They hide the hip and knee.

In testing with synthetic jumps of known height (25 to 70 cm, at 30, 60, and 240 fps, plus 4x and 8x slow motion), the measurement landed within about 1 cm of the true value. Real-world accuracy depends on the AI landmarks, so test against a known reference, such as a jump-and-reach wall mark, before relying on it.

## Deploy on GitHub Pages

1. Create a new **public** repository on GitHub, for example `jumpcam`.
2. Click **Add file**, then **Upload files**, and drag in all the files from this folder, including `README.md`. They must be at the top level of the repository, not inside a subfolder.
3. Click **Commit changes**.
4. Go to **Settings**, then **Pages**. Under **Build and deployment**, choose **Deploy from a branch**, then select **main** and **/ (root)**. Click **Save**.
5. Wait 1 to 2 minutes. Your app will be at `https://<your-username>.github.io/jumpcam/`.
6. Open it on your phone. The first analysis downloads the AI library and model (about 20 MB), so do it on Wi-Fi.
7. Optional: add it to the home screen. In Safari, tap **Share**, then **Add to Home Screen**. In Chrome, open the menu, then tap **Install app** or **Add to Home screen**.

### Updating the app

After editing any file, change `APP_VERSION` in `sw.js` (for example, from `v1` to `v2`) and upload the changed files. Otherwise, phones keep showing the old saved version.

### Changing the AI model or library version

The URLs are at the top of `app.js` (`MP_VERSION`, `MODEL_URL`). The model defaults to **full** for accuracy. For a smaller, faster download (about 5 MB instead of 9 MB), replace `pose_landmarker_full` with `pose_landmarker_lite` in both places in the model URL. If you change `MP_VERSION`, also change `LIB_CACHE` in `sw.js` so the new files are saved.

## Debug mode

Turn it on in **Settings**. The results screen then shows a graph of hip rise and toe height over time, with the calibration window shaded and lines at takeoff, peak, and landing. It also shows the raw numbers (scale, thresholds, frame numbers) used to tune the detection settings.

## Privacy

- Videos are read only on the phone. They are never uploaded or saved by the app.
- The only network requests are for the app files, the MediaPipe library, and the model.
- Saved jumps (date, height, warnings) are stored in the browser's IndexedDB on that phone. Clearing the browser data deletes them.
