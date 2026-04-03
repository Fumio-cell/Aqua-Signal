import { WebGLUtility } from './WebGLUtility';
import {
  VERT_SHADER,
  WET_DIFFUSE_FRAG,
  PIG_DIFFUSE_FRAG,
  WET_INTERACT_FRAG,
  PIG_INTERACT_FRAG,
  PIG_FIXED_INTERACT_FRAG,
  PIG_FIX_FRAG,
  PIG_SUBTRACT_FRAG,
  PIG_DISSOLVE_FRAG,
  FIXED_PIG_SUBTRACT_FRAG,
  RENDER_FRAG,
  PIG_FIX_ALL_FRAG,
  BLIT_FRAG
} from './shaders';

export interface SimulationParams {
  width: number;
  height: number;
  seed: number;
  chaos: number;
  noiseScale: number;
  flowIrregularity: number;
  spread: number;
  evaporation: number;
  granulation: number;
  edgeDarkening: number;
  bloom: number;
  flowSpeed: number;    // was timeScale
  isPlaying: boolean;
  mousePos: [number, number];
  isMouseDown: boolean;
  brushSize: number;
  waterAmount: number;
  pigmentColor: [number, number, number, number]; // r,g,b,density
  injectionForce: number;
  paperRoughness: number;
  waterOnly: boolean;   // true = 水のみ（顔料なし）スポイト
}

// ---- tiny uniform helpers ----
function u1f(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, v: number) {
  const loc = gl.getUniformLocation(prog, name);
  if (loc) gl.uniform1f(loc, v);
}
function u2f(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, x: number, y: number) {
  const loc = gl.getUniformLocation(prog, name);
  if (loc) gl.uniform2f(loc, x, y);
}
function u3f(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, x: number, y: number, z: number) {
  const loc = gl.getUniformLocation(prog, name);
  if (loc) gl.uniform3f(loc, x, y, z);
}
function bindTex(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, unit: number, tex: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const loc = gl.getUniformLocation(prog, name);
  if (loc) gl.uniform1i(loc, unit);
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

export class SimulationEngine {
  private gl: WebGL2RenderingContext;
  private width: number;
  private height: number;

  // Double-buffered separate textures
  // wetness[i]: RGBA16F, R=wetness (GBA unused)
  // pigment[i]: RGBA16F, RGB=premul color, A=density
  private wetTex: [WebGLTexture, WebGLTexture];
  private pigTex: [WebGLTexture, WebGLTexture];
  private wetFB: [WebGLFramebuffer, WebGLFramebuffer];
  private pigFB: [WebGLFramebuffer, WebGLFramebuffer];
  private fixedPigTex: [WebGLTexture, WebGLTexture];
  private fixedPigFB: [WebGLFramebuffer, WebGLFramebuffer];

  // Undo snapshots
  private undoWetTex: WebGLTexture;
  private undoPigTex: WebGLTexture;
  private undoWetFB: WebGLFramebuffer;
  private undoPigFB: WebGLFramebuffer;
  private undoFixedPigTex: WebGLTexture;
  private undoFixedPigFB: WebGLFramebuffer;

  // Shader programs
  private wetDiffProg: WebGLProgram;
  private pigDiffProg: WebGLProgram;
  private wetInterProg: WebGLProgram;
  private pigInterProg: WebGLProgram;
  private fixedPigInterProg: WebGLProgram;
  private pigFixProg: WebGLProgram;
  private pigSubProg: WebGLProgram;
  private pigDissolveProg: WebGLProgram;
  private fixedPigSubProg: WebGLProgram;
  private pigFixAllProg: WebGLProgram;
  private renderProg: WebGLProgram;
  private blitProg: WebGLProgram;

  private vao: WebGLVertexArrayObject;
  private currentIdx = 0;
  private prevMousePos: [number, number] | null = null;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    this.wetTex = [this.makeTex(), this.makeTex()];
    this.pigTex = [this.makeTex(), this.makeTex()];
    this.wetFB  = [this.makeFB(this.wetTex[0]), this.makeFB(this.wetTex[1])];
    this.pigFB  = [this.makeFB(this.pigTex[0]), this.makeFB(this.pigTex[1])];

    this.undoWetTex = this.makeTex();
    this.undoPigTex = this.makeTex();
    this.undoWetFB  = this.makeFB(this.undoWetTex);
    this.undoPigFB  = this.makeFB(this.undoPigTex);
    this.undoFixedPigTex = this.makeTex();
    this.undoFixedPigFB  = this.makeFB(this.undoFixedPigTex);

    this.fixedPigTex = [this.makeTex(), this.makeTex()];
    this.fixedPigFB  = [this.makeFB(this.fixedPigTex[0]), this.makeFB(this.fixedPigTex[1])];

    // Create programs
    const P = (fs: string) => WebGLUtility.createProgram(gl, VERT_SHADER, fs);
    this.wetDiffProg  = P(WET_DIFFUSE_FRAG);
    this.pigDiffProg  = P(PIG_DIFFUSE_FRAG);
    this.wetInterProg = P(WET_INTERACT_FRAG);
    this.pigInterProg = P(PIG_INTERACT_FRAG);
    this.fixedPigInterProg = P(PIG_FIXED_INTERACT_FRAG);
    this.pigFixProg   = P(PIG_FIX_FRAG);
    this.pigSubProg   = P(PIG_SUBTRACT_FRAG);
    this.pigDissolveProg = P(PIG_DISSOLVE_FRAG);
    this.fixedPigSubProg = P(FIXED_PIG_SUBTRACT_FRAG);
    this.pigFixAllProg = P(PIG_FIX_ALL_FRAG);
    this.renderProg   = P(RENDER_FRAG);
    this.blitProg     = P(BLIT_FRAG);

    // VAO (required in WebGL2)
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]),
      gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  // ---- private helpers ----
  private makeTex(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.width, this.height,
      0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private makeFB(tex: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const s = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (s !== gl.FRAMEBUFFER_COMPLETE) console.error('FB incomplete:', s.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fb;
  }

  private setViewport(fb: WebGLFramebuffer | null) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  private clearFB(fb: WebGLFramebuffer) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  private drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // Unbind textures to prevent feedback loops in subsequent passes
    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  // ---- Public API ----

  /** Advance simulation one timestep */
  public step(p: SimulationParams, dt: number) {
    const gl = this.gl;
    const cur  = this.currentIdx;
    const next = 1 - cur;
    const scaledDT = dt * p.flowSpeed;

    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 1. Diffuse wetness
    gl.useProgram(this.wetDiffProg);
    this.setViewport(this.wetFB[next]);
    bindTex(gl, this.wetDiffProg, 'u_wetness', 0, this.wetTex[cur]);
    bindTex(gl, this.wetDiffProg, 'u_pigment', 1, this.pigTex[cur]);
    u1f(gl, this.wetDiffProg, 'u_spread',          p.spread);
    u1f(gl, this.wetDiffProg, 'u_evaporation',     p.evaporation);
    u1f(gl, this.wetDiffProg, 'u_dt',              scaledDT);
    u1f(gl, this.wetDiffProg, 'u_dt_dry',          dt); 
    u1f(gl, this.wetDiffProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.wetDiffProg, 'u_seed',            p.seed);
    u1f(gl, this.wetDiffProg, 'u_dissolve_dry',    p.waterOnly ? 1.0 : 0.0);
    u2f(gl, this.wetDiffProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();

    // --------------------------------------------------------
    // PIGMENT Sequential Pipeline
    // --------------------------------------------------------
    
    // Pass 1: Re-wetting / Dissolve (Fixed -> Active)
    gl.useProgram(this.pigDissolveProg);
    this.setViewport(this.pigFB[next]); // Write to Active[next]
    bindTex(gl, this.pigDissolveProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigDissolveProg, 'u_pigment', 1, this.pigTex[cur]);
    bindTex(gl, this.pigDissolveProg, 'u_fixed_pigment', 2, this.fixedPigTex[cur]);
    u2f(gl, this.pigDissolveProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    gl.useProgram(this.fixedPigSubProg);
    this.setViewport(this.fixedPigFB[next]); // Write to Fixed[next]
    bindTex(gl, this.fixedPigSubProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.fixedPigSubProg, 'u_fixed_pigment', 1, this.fixedPigTex[cur]);
    this.drawQuad();

    // Pass 2: Pigment Diffusion (on Active)
    // Now Active[next] and Fixed[next] are the updated states.
    // We diffuse Active[next] and write to Active[cur] (as temp result).
    gl.useProgram(this.pigDiffProg);
    this.setViewport(this.pigFB[cur]);
    bindTex(gl, this.pigDiffProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigDiffProg, 'u_pigment', 1, this.pigTex[next]);
    u1f(gl, this.pigDiffProg, 'u_spread',      p.spread);
    u1f(gl, this.pigDiffProg, 'u_dt',          scaledDT);
    u1f(gl, this.pigDiffProg, 'u_water_boost', p.waterOnly ? 6.0 : 1.0);
    u1f(gl, this.pigDiffProg, 'u_paper_roughness', p.paperRoughness); 
    u1f(gl, this.pigDiffProg, 'u_seed',            p.seed);
    u2f(gl, this.pigDiffProg, 'u_resolution',  this.width, this.height);
    this.drawQuad();

    // Pass 3: Fix pigment (Active -> Fixed)
    // We read Active[cur] (diffused) and Fixed[next] (from dissolve)
    // Target: Fixed[cur]
    gl.useProgram(this.pigFixProg);
    this.setViewport(this.fixedPigFB[cur]);
    bindTex(gl, this.pigFixProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigFixProg, 'u_pigment', 1, this.pigTex[cur]);
    bindTex(gl, this.pigFixProg, 'u_fixed_pigment', 2, this.fixedPigTex[next]);
    u1f(gl, this.pigFixProg, 'u_dt', scaledDT);
    u2f(gl, this.pigFixProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    // Pass 4: Finalize Active (Subtract the fixed part)
    // We read Active[cur] and write back to Active[next] (to be consistent)
    gl.useProgram(this.pigSubProg);
    this.setViewport(this.pigFB[next]);
    bindTex(gl, this.pigSubProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigSubProg, 'u_pigment', 1, this.pigTex[cur]);
    u1f(gl, this.pigSubProg, 'u_dt',          scaledDT);
    u2f(gl, this.pigSubProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    // Final Sync: Now Active[next] is the final active, and Fixed[cur] is the final fixed.
    // To keep it simple, we blit Fixed[cur] -> Fixed[next] so both are synchronized.
    this.blitTex(this.fixedPigTex[cur], this.fixedPigFB[next]);

    this.currentIdx = next;
  }

  /** Force fix all active pigment to fixed layer (e.g. on freeze or new layer) */
  public fixAllPigment() {
    const gl = this.gl;
    const cur = this.currentIdx;
    const next = 1 - cur;

    // 1. Combine onto the 'next' buffer first (avoid feedback loop)
    gl.useProgram(this.pigFixAllProg);
    this.setViewport(this.fixedPigFB[next]);
    bindTex(gl, this.pigFixAllProg, 'u_active', 0, this.pigTex[cur]);
    bindTex(gl, this.pigFixAllProg, 'u_fixed', 1, this.fixedPigTex[cur]);
    this.drawQuad();

    // 2. Sync 'cur' from 'next'
    this.blitTex(this.fixedPigTex[next], this.fixedPigFB[cur]);

    // 3. Clear active and wetness
    const fbs = [this.wetFB[0], this.wetFB[1], this.pigFB[0], this.pigFB[1]];
    fbs.forEach(fb => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** 
   * Inject water + pigment at mouse position.
   * Handles path interpolation to ensure continuous strokes.
   */
  public interact(p: SimulationParams) {
    const gl = this.gl;
    const cur  = this.currentIdx;
    const next = 1 - cur;
    const mx   = p.mousePos[0];
    const my   = this.height - p.mousePos[1]; // flip Y

    if (!p.isMouseDown) {
      this.prevMousePos = null;
      return;
    }

    const points: [number, number][] = [];
    if (this.prevMousePos) {
      const dx = mx - this.prevMousePos[0];
      const dy = my - this.prevMousePos[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
      // ブラシサイズの1/4間隔で補間して「泡立ち」を防ぐ
      const stepCount = Math.max(1, Math.ceil(dist / (p.brushSize * 0.25)));
      for (let i = 1; i <= stepCount; i++) {
        const t = i / stepCount;
        points.push([
          this.prevMousePos[0] + dx * t,
          this.prevMousePos[1] + dy * t
        ]);
      }
    } else {
      points.push([mx, my]);
    }
    this.prevMousePos = [mx, my];

    for (const pt of points) {
      const px = pt[0];
      const py = pt[1];

      // 3. Inject wetness
      gl.useProgram(this.wetInterProg);
      this.setViewport(this.wetFB[next]);
      bindTex(gl, this.wetInterProg, 'u_wetness', 0, this.wetTex[cur]);
      u2f(gl, this.wetInterProg, 'u_mouse',      px, py);
      u1f(gl, this.wetInterProg, 'u_radius',     p.brushSize);
      u1f(gl, this.wetInterProg, 'u_water',      p.waterAmount);
      u1f(gl, this.wetInterProg, 'u_force',      p.injectionForce);
      u2f(gl, this.wetInterProg, 'u_resolution', this.width, this.height);
      this.drawQuad();
      this.blitTex(this.wetTex[next], this.wetFB[cur]); // 即時同期

      // 4. Inject pigment
      if (!p.waterOnly) {
        gl.useProgram(this.pigInterProg);
        this.setViewport(this.pigFB[next]);
        bindTex(gl, this.pigInterProg, 'u_pigment', 0, this.pigTex[cur]);
        u2f(gl, this.pigInterProg, 'u_mouse',      px, py);
        u1f(gl, this.pigInterProg, 'u_radius',     p.brushSize);
        u3f(gl, this.pigInterProg, 'u_color',
          p.pigmentColor[0], p.pigmentColor[1], p.pigmentColor[2]);
        u1f(gl, this.pigInterProg, 'u_density',    p.pigmentColor[3]);
        u1f(gl, this.pigInterProg, 'u_force',      p.injectionForce);
        u2f(gl, this.pigInterProg, 'u_resolution', this.width, this.height);
        this.drawQuad();
        this.blitTex(this.pigTex[next], this.pigFB[cur]); 

        gl.useProgram(this.fixedPigInterProg);
        this.setViewport(this.fixedPigFB[next]);
        bindTex(gl, this.fixedPigInterProg, 'u_fixed_pigment', 0, this.fixedPigTex[cur]);
        u2f(gl, this.fixedPigInterProg, 'u_mouse',      px, py);
        u1f(gl, this.fixedPigInterProg, 'u_radius',     p.brushSize);
        u3f(gl, this.fixedPigInterProg, 'u_color',
          p.pigmentColor[0], p.pigmentColor[1], p.pigmentColor[2]);
        u1f(gl, this.fixedPigInterProg, 'u_density',    p.pigmentColor[3]);
        u1f(gl, this.fixedPigInterProg, 'u_force',      p.injectionForce);
        u2f(gl, this.fixedPigInterProg, 'u_resolution', this.width, this.height);
        this.drawQuad();
        this.blitTex(this.fixedPigTex[next], this.fixedPigFB[cur]);
      }
    }

    if (p.waterOnly) {
      this.blitTex(this.pigTex[cur], this.pigFB[next]);
    }
    this.currentIdx = next;
  }

  /** Render to screen */
  public render(p: SimulationParams) {
    const gl = this.gl;
    this.setViewport(null);
    gl.useProgram(this.renderProg);
    bindTex(gl, this.renderProg, 'u_wetness', 0, this.wetTex[this.currentIdx]);
    bindTex(gl, this.renderProg, 'u_pigment', 1, this.pigTex[this.currentIdx]);
    bindTex(gl, this.renderProg, 'u_fixed_pigment', 2, this.fixedPigTex[this.currentIdx]);
    u1f(gl, this.renderProg, 'u_granulation',     p.granulation);
    u1f(gl, this.renderProg, 'u_edge_darkening',  p.edgeDarkening);
    u1f(gl, this.renderProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.renderProg, 'u_seed',            p.seed);
    u2f(gl, this.renderProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();
  }

  /** Clear all textures and state */
  public clear() {
    this.currentIdx = 0;
    this.prevMousePos = null;
    
    // Clear all simulation and undo buffers
    const fbs = [
      this.wetFB[0], this.wetFB[1],
      this.pigFB[0], this.pigFB[1],
      this.fixedPigFB[0], this.fixedPigFB[1],
      this.undoWetFB, this.undoPigFB,
      this.undoFixedPigFB
    ];
    fbs.forEach(fb => this.clearFB(fb));
    
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  /** Save undo snapshot */
  /**
   * Import an image as fixed pigment.
   * This allows the user to 're-edit' a photo with the watercolor effect.
   */
  public importImage(img: HTMLImageElement) {
    const gl = this.gl;
    const cur = this.currentIdx;

    // 1. Create a temporary canvas for resizing and aspect-ratio maintenance
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const ctx = tempCanvas.getContext('2d')!;

    // Background should be transparent or match paper color? 
    // We treat it as ink, so transparent/black-alpha is best.
    ctx.clearRect(0, 0, this.width, this.height);

    // Calculate scaling (Fit Contain)
    const scale = Math.min(this.width / img.width, this.height / img.height);
    const nw = img.width * scale;
    const nh = img.height * scale;
    const nx = (this.width - nw) / 2;
    const ny = (this.height - nh) / 2;

    ctx.drawImage(img, nx, ny, nw, nh);
    const imageData = ctx.getImageData(0, 0, this.width, this.height);
    const pixels = imageData.data;

    // 2. Convert white areas to transparent (Treating white as paper)
    // Also flip Y-axis for WebGL (which starts (0,0) at bottom-left)
    const floatPixels = new Float32Array(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const srcIdx = (y * this.width + x) * 4;
        // WebGL is bottom-to-top, so we flip Y here
        const dstIdx = ((this.height - 1 - y) * this.width + x) * 4;

        const r = pixels[srcIdx] / 255;
        const g = pixels[srcIdx+1] / 255;
        const b = pixels[srcIdx+2] / 255;
        const gray = (r + g + b) / 3.0;

        // Simple white-to-alpha: bright areas become transparent (paper)
        let a = 1.0 - smoothstep(0.85, 0.98, gray); 
        a = clamp(a * 1.5, 0.0, 1.0);

        floatPixels[dstIdx]   = r * a;
        floatPixels[dstIdx+1] = g * a;
        floatPixels[dstIdx+2] = b * a;
        floatPixels[dstIdx+3] = a;
      }
    }

    // 3. Upload to fixedPigTex
    gl.bindTexture(gl.TEXTURE_2D, this.fixedPigTex[cur]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, floatPixels);

    // 4. Force a render to update the view
    // (Actual simulation step happens in RAF)
  }

  public saveUndoState() {
    this.blitTex(this.wetTex[this.currentIdx], this.undoWetFB);
    this.blitTex(this.pigTex[this.currentIdx], this.undoPigFB);
    this.blitTex(this.fixedPigTex[this.currentIdx], this.undoFixedPigFB);
  }

  /** Restore undo snapshot */
  public restoreUndoState() {
    this.blitTex(this.undoWetTex, this.wetFB[this.currentIdx]);
    this.blitTex(this.undoPigTex, this.pigFB[this.currentIdx]);
    this.blitTex(this.undoFixedPigTex, this.fixedPigFB[this.currentIdx]);
  }

  private blitTex(src: WebGLTexture, dstFB: WebGLFramebuffer) {
    const gl = this.gl;
    gl.useProgram(this.blitProg);
    this.setViewport(dstFB);
    bindTex(gl, this.blitProg, 'u_src', 0, src);
    this.drawQuad();
  }

}
