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
    granulation: 0.75,
    edgeDarkening: 0.4,
    bloom: 0.3,
    flowSpeed: 50.0,
    isPlaying: true,
    mousePos: [0, 0],
    isMouseDown: false,
    brushSize: 80,
    waterAmount: 0.7,
    pigmentColor: [0.08, 0.08, 0.08, 1.0], // Dark ink by default
    injectionForce: 1.5,
    paperRoughness: 2.2,
    waterOnly: false,
  });

  // Stale closure fix: always read latest params in RAF loop
  const paramsRef = useRef<SimulationParams>(params);
  useEffect(() => { paramsRef.current = params; }, [params]);

  // glRef: WebGLコンテキストをexport関数から参照できるようにする
  const lastTimeRef = useRef<number>(0);
  const glRef = useRef<WebGL2RenderingContext | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const gl = canvasRef.current.getContext('webgl2', {
      alpha: false, depth: false, preserveDrawingBuffer: true,
    });
    if (!gl) { alert('WebGL 2 not supported'); return; }
    gl.getExtension('EXT_color_buffer_float');
    glRef.current = gl;

    engineRef.current = new SimulationEngine(gl, width, height);

    let rafId: number;
    const animate = (time: number) => {
      const dt = Math.min((time - lastTimeRef.current) / 1000, 0.05);
      lastTimeRef.current = time;
      const p = paramsRef.current;

      if (engineRef.current) {
        // Sub-stepping for stability at high flowSpeed
        // 1フレームを 32分割して計算することで、爆発を防ぎつつ高速化を実現
        if (p.isPlaying) {
          const subSteps = 32;
          const subDT = dt / subSteps;
          for (let i = 0; i < subSteps; i++) {
            engineRef.current.step(p, subDT);
          }
          if (p.isMouseDown) engineRef.current.interact(p);
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
      // 停止 (isPlaying: false) に切り替わった瞬間に強制定着させる
      if (prev.isPlaying && !newState.isPlaying) {
        engineRef.current?.fixAllPigment();
      }
      return newState;
    });
  }, []);

  const undo = useCallback(() => {
    engineRef.current?.restoreUndoState();
  }, []);

  /** ダウンロードヘルパー */
  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const timestamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  /** 通常 PNG（オプションで2Kにアップスケール）*/
  const exportPNG = useCallback(async (size: number = 1024) => {
    const src = canvasRef.current;
    if (!src) return;

    if (size === src.width) {
      // ネイティブサイズはそのままblob
      const blob = await new Promise<Blob | null>(r => src.toBlob(r, 'image/png'));
      if (blob) downloadBlob(blob, `watercolor_${size}px_${timestamp()}.png`);
      return;
    }

    // アップスケール: 2D canvasで高品質リサンプリング
    const out = document.createElement('canvas');
    out.width = size; out.height = size;
    const ctx = out.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, size, size);
    const blob = await new Promise<Blob | null>(r => out.toBlob(r, 'image/png'));
    if (blob) downloadBlob(blob, `watercolor_${size}px_${timestamp()}.png`);
  }, []);

  /** 透過 PNG：紙の背景色を除算してインクのみを抽出 */
  const exportTransparentPNG = useCallback(async (size: number = 1024) => {
    const src = canvasRef.current;
    if (!src) return;

    const W = src.width, H = src.height;

    // preserveDrawingBuffer:true なので WebGL canvas を 2D canvas に drawImage して取得
    // gl.readPixels より確実（FBO状態・Y軸・alpha:false の問題を全て回避）
    const read2d = document.createElement('canvas');
    read2d.width = W; read2d.height = H;
    const readCtx = read2d.getContext('2d', { willReadFrequently: true })!;
    readCtx.drawImage(src, 0, 0);
    const imageData = readCtx.getImageData(0, 0, W, H);
    const pixels = imageData.data; // Uint8ClampedArray (RGBA, in-place)

    // 紙のベースカラー (RENDER_FRAG の paperBase に合わせる)
    // vec3(0.970, 0.960, 0.940) → (247, 245, 240)
    const PR = 247, PG = 245, PB = 240;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i], g = pixels[i+1], b = pixels[i+2];

      // 紙色からの差分（明るい紙に対してインクは暗いor着色）
      const dr = PR - r, dg = PG - g, db = PB - b;
      // 各チャンネルの最大差分でインク密度を推定（0=紙, 1=純粋インク）
      const rawInk = Math.max(dr, dg, db, 0) / 140; // 140≈55%の差でalpha=1
      const alpha  = Math.min(1, rawInk * 1.4);     // 少し増幅してエッジを明確に

      if (alpha < 0.01) {
        // ほぼ紙色 → 完全透明
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
      } else {
        // インク色を逆算: pix = paper*(1-a) + ink*a → ink = (pix - paper*(1-a)) / a
        pixels[i]   = Math.min(255, Math.max(0, Math.round((r - PR * (1 - alpha)) / alpha)));
        pixels[i+1] = Math.min(255, Math.max(0, Math.round((g - PG * (1 - alpha)) / alpha)));
        pixels[i+2] = Math.min(255, Math.max(0, Math.round((b - PB * (1 - alpha)) / alpha)));
        pixels[i+3] = Math.round(alpha * 255);
      }
    }

    // ネイティブサイズ → 出力サイズへスケール
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

  return { canvasRef, engineRef, params, updateParams, undo, exportPNG, exportTransparentPNG };
}
