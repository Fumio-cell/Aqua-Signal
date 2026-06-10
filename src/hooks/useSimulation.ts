import { useState, useRef, useEffect, useCallback } from 'react';
import type { SimulationParams } from '../lib/renderer/SimulationEngine';
import { SimulationEngine } from '../lib/renderer/SimulationEngine';


export function useSimulation(width: number, height: number) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const engineRef  = useRef<SimulationEngine | null>(null);

  const [params, setParams] = useState<SimulationParams>({
    width, height,
    seed: Math.random() * 1000,
    chaos: 0.5,
    noiseScale: 1.0,
    flowIrregularity: 0.5,
    spread: 0.35,
    evaporation: 0.002,
    granulation: 0.40,
    edgeDarkening: 0.4,
    bloom: 0.3,
    dissolveRate: 0.15,
    flowSpeed: 50.0,
    isPlaying: true,
    mousePos: [0, 0],
    isMouseDown: false,
    brushSize: 80,
    waterAmount: 0.7,
    pigmentColor: [0.10, 0.25, 0.82, 0.4], // Reduced density for transparency
    injectionForce: 1.5,
    paperRoughness: 1.4,
    waterOnly: false,
  });

  // Stale closure fix: always read latest params in RAF loop
  const paramsRef = useRef<SimulationParams>(params);
  useEffect(() => { paramsRef.current = params; }, [params]);

  // glRef: allow export functions to access the WebGL context
  const lastTimeRef = useRef<number>(0);
  const glRef = useRef<WebGL2RenderingContext | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const gl = canvasRef.current.getContext('webgl2', {
      alpha: false, depth: false, preserveDrawingBuffer: true,
    });
    if (!gl) { alert('WebGL 2 not supported'); return; }
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_half_float_linear'); // Important for smooth advection
    gl.getExtension('OES_texture_float_linear');
    glRef.current = gl;

    engineRef.current = new SimulationEngine(gl, width, height);

    let rafId: number;
    const animate = (time: number) => {
      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = time;
      const p = paramsRef.current;

      if (engineRef.current) {
        // Sub-stepping for stability at high flowSpeed
        // Sub-step 32 times per frame to prevent blowup while achieving high speed
        if (p.isPlaying) {
          const subSteps = 32;
          const subDT = dt / subSteps;
          for (let i = 0; i < subSteps; i++) {
            // Run interact inside loop to smooth out input
            engineRef.current.interact(p, subDT);
            engineRef.current.step(p, subDT);
          }
        }
        engineRef.current.render(p);
      }
      rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [width, height]);

  const updateParams = useCallback((next: Partial<SimulationParams>) => {
    setParams(prev => {
      const newState = { ...prev, ...next };
      // Fix all pigment at the moment playback is stopped (isPlaying: false)
      if (prev.isPlaying && !newState.isPlaying) {
        engineRef.current?.fixAllPigment();
      }
      return newState;
    });
  }, []);

  const undo = useCallback(() => {
    engineRef.current?.restoreUndoState();
  }, []);

  /** Download helper */
  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const timestamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  /** Standard PNG (optionally upscaled to 2K) */
  const exportPNG = useCallback(async (size: number = 1024) => {
    const src = canvasRef.current;
    if (!src) return;

    if (size === src.width) {
      // Native size: export as blob directly
      const blob = await new Promise<Blob | null>(r => src.toBlob(r, 'image/png'));
      if (blob) downloadBlob(blob, `watercolor_${size}px_${timestamp()}.png`);
      return;
    }

    // Upscale: high-quality resampling via 2D canvas
    const out = document.createElement('canvas');
    out.width = size; out.height = size;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, size, size);
    const blob = await new Promise<Blob | null>(r => out.toBlob(r, 'image/png'));
    if (blob) downloadBlob(blob, `watercolor_${size}px_${timestamp()}.png`);
  }, []);

  /** Transparent PNG: divide out paper background to extract ink only */
  const exportTransparentPNG = useCallback(async (size: number = 1024) => {
    const src = canvasRef.current;
    if (!src) return;

    const W = src.width, H = src.height;

    // Since preserveDrawingBuffer:true, draw WebGL canvas to 2D canvas for readback
    // More reliable than gl.readPixels (avoids FBO state / Y-axis / alpha:false issues)
    const read2d = document.createElement('canvas');
    read2d.width = W; read2d.height = H;
    const readCtx = read2d.getContext('2d', { willReadFrequently: true })!;
    readCtx.drawImage(src, 0, 0);
    const imageData = readCtx.getImageData(0, 0, W, H);
    const pixels = imageData.data; // Uint8ClampedArray (RGBA, in-place)

    // Paper base color (matches RENDER_FRAG paperBase)
    // vec3(0.970, 0.960, 0.940) → (247, 245, 240)
    const PR = 247, PG = 245, PB = 240;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i+1], b = pixels[i+2];

      // Difference from paper color (ink is darker/colored against light paper)
      const dr = PR - r, dg = PG - g, db = PB - b;
      // Estimate ink density from max channel difference (0=paper, 1=pure ink)
      const rawInk = Math.max(dr, dg, db, 0) / 140; // 140 ≈ 55% diff → alpha=1
      const alpha  = Math.min(1, rawInk * 1.4);     // Slightly amplify to sharpen edges

      if (alpha < 0.01) {
        // Nearly paper color → fully transparent
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
      } else {
        // Back-calculate ink color: pix = paper*(1-a) + ink*a => ink = (pix - paper*(1-a)) / a
        pixels[i]   = Math.min(255, Math.max(0, Math.round((r - PR * (1 - alpha)) / alpha)));
        pixels[i+1] = Math.min(255, Math.max(0, Math.round((g - PG * (1 - alpha)) / alpha)));
        pixels[i+2] = Math.min(255, Math.max(0, Math.round((b - PB * (1 - alpha)) / alpha)));
        pixels[i+3] = Math.round(alpha * 255);
      }
    }

    // Scale from native size to output size
    const native = document.createElement('canvas');
    native.width = W; native.height = H;
    native.getContext('2d')!.putImageData(new ImageData(pixels, W, H), 0, 0);

    const out = document.createElement('canvas');
    out.width = size; out.height = size;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(native, 0, 0, size, size);

    const blob = await new Promise<Blob | null>(r => out.toBlob(r, 'image/png'));
    if (blob) downloadBlob(blob, `watercolor_transparent_${size}px_${timestamp()}.png`);
  }, []);

  const importImage = useCallback((img: HTMLImageElement) => {
    engineRef.current?.importImage(img);
  }, []);

  return { canvasRef, engineRef, params, updateParams, undo, exportPNG, exportTransparentPNG, importImage };
}
