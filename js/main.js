// Temporary probe — replaced in Task 4.
const status = document.getElementById('status');

async function probe() {
  const meta = await fetch('model/labels.json').then(r => r.json());
  ort.env.wasm.wasmPaths = 'vendor/';
  ort.env.wasm.numThreads = 1;             // GitHub Pages has no COOP/COEP
  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const t0 = performance.now();
  const session = await ort.InferenceSession.create('model/best.onnx', {
    executionProviders: providers, graphOptimizationLevel: 'all',
  });
  const dt = Math.round(performance.now() - t0);
  const dummy = new ort.Tensor('float32', new Float32Array(3 * meta.imgsz * meta.imgsz),
                               [1, 3, meta.imgsz, meta.imgsz]);
  const out = await session.run({ [session.inputNames[0]]: dummy });
  const o = out[session.outputNames[0]];
  status.textContent =
    `OK in ${dt}ms | in=${session.inputNames} out=${session.outputNames} ` +
    `dims=[${o.dims}] classes=${meta.names.length}`;
  console.log('providers tried', providers, 'output dims', o.dims);
}

probe().catch(e => { status.textContent = 'FAILED: ' + e.message; console.error(e); });
