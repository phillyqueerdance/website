# Discovery Map face detector

The browser worker runs the MediaPipe short-range face detector on already published artist photos. It uses the Apache 2.0 license in this directory.

- `model.json` and `group1-shard1of1.bin` are the TensorFlow.js graph and weights from `https://tfhub.dev/mediapipe/tfjs-model/face_detection/short/1`.
- `runtime.js` bundles `@tensorflow/tfjs-core`, `@tensorflow/tfjs-backend-cpu`, and `@tensorflow/tfjs-converter` at `4.22.0` and `@tensorflow-models/face-detection` at `1.0.3`. The upstream sources are https://github.com/tensorflow/tfjs and https://github.com/tensorflow/tfjs-models/tree/master/face-detection.

To rebuild the bundle with esbuild `0.25.12`, use these imports as the entry point and build with `--bundle --platform=browser --format=esm --minify --legal-comments=eof`.

```js
import '@tensorflow/tfjs-backend-cpu';
export { browser, setBackend, slice } from '@tensorflow/tfjs-core';
export { load } from '@tensorflow-models/face-detection/dist/tfjs/detector.js';
```
