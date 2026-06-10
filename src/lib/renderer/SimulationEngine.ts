import { WebGLUtility } from './WebGLUtility';
import {
  VERT_SHADER,
  WET_DIFFUSE_FRAG,
  PIG_DIFFUSE_FRAG,
  WET_INTERACT_FRAG,
  PIG_INTERACT_FRAG,
  PIG_FIX_FRAG,
  PIG_SUBTRACT_FRAG,
  PIG_DISSOLVE_FRAG,
  FIXED_PIG_SUBTRACT_FRAG,
  RENDER_FRAG,
  PIG_FIX_ALL_FRAG,
  PIG_GRANULATION_FRAG,
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
  dissolveRate: number;
  flowSpeed: number;
  isPlaying: boolean;
  mousePos: [number, number];
  isMouseDown: boolean;
  brushSize: number;
  waterAmount: number;
  pigmentColor: [number, number, number, number]; // r,g,b,density
  injectionForce: number;
  paperRoughness: number;
  waterOnly: boolean;
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

export class SimulationEngine {
  private gl: WebGL2RenderingContext;
  private width: number;
  private height: number;

  private wetTex: [WebGLTexture, WebGLTexture];
  private pigTex: [WebGLTexture, WebGLTexture];
  private wetFB: [WebGLFramebuffer, WebGLFramebuffer];
  private pigFB: [WebGLFramebuffer, WebGLFramebuffer];
  private fixedPigTex: [WebGLTexture, WebGLTexture];
  private fixedPigFB: [WebGLFramebuffer, WebGLFramebuffer];

  private undoWetTex: WebGLTexture;
  private undoPigTex: WebGLTexture;
  private undoWetFB: WebGLFramebuffer;
  private undoPigFB: WebGLFramebuffer;
  private undoFixedPigTex: WebGLTexture;
  private undoFixedPigFB: WebGLFramebuffer;

  private backgroundTex: WebGLTexture;
  private backgroundFB: WebGLFramebuffer;

  private wetDiffProg: WebGLProgram;
  private pigDiffProg: WebGLProgram;
  private wetInterProg: WebGLProgram;
  private pigInterProg: WebGLProgram;
  private pigFixProg: WebGLProgram;
  private pigSubProg: WebGLProgram;
  private pigDissolveProg: WebGLProgram;
  private pigGranulationProg: WebGLProgram;
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

    this.backgroundTex = this.makeTex();
    this.backgroundFB  = this.makeFB(this.backgroundTex);

    this.initTextures();

    const P = (fs: string) => WebGLUtility.createProgram(gl, VERT_SHADER, fs);
    this.wetDiffProg  = P(WET_DIFFUSE_FRAG);
    this.pigDiffProg  = P(PIG_DIFFUSE_FRAG);
    this.wetInterProg = P(WET_INTERACT_FRAG);
    this.pigInterProg = P(PIG_INTERACT_FRAG);
    this.pigFixProg   = P(PIG_FIX_FRAG);
    this.pigSubProg   = P(PIG_SUBTRACT_FRAG);
    this.pigDissolveProg = P(PIG_DISSOLVE_FRAG);
    this.pigGranulationProg = P(PIG_GRANULATION_FRAG);
    this.fixedPigSubProg = P(FIXED_PIG_SUBTRACT_FRAG);
    this.pigFixAllProg = P(PIG_FIX_ALL_FRAG);
    this.renderProg   = P(RENDER_FRAG);
    this.blitProg     = P(BLIT_FRAG);

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

  private initTextures() {
    this.clearFB(this.wetFB[0]);
    this.clearFB(this.wetFB[1]);
    this.clearFB(this.pigFB[0]);
    this.clearFB(this.pigFB[1]);
    this.clearFB(this.fixedPigFB[0]);
    this.clearFB(this.fixedPigFB[1]);
    
    const gl = this.gl;
    this.setViewport(this.backgroundFB);
    gl.clearColor(0.97, 0.96, 0.94, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

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

    for (let i = 0; i < 4; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  public step(p: SimulationParams, dt: number) {
    const gl = this.gl;
    const cur  = this.currentIdx;
    const next = 1 - cur;
    const scaledDT = dt * p.flowSpeed;

    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    // 1. Wetness Diffusion
    gl.useProgram(this.wetDiffProg);
    this.setViewport(this.wetFB[next]);
    bindTex(gl, this.wetDiffProg, 'u_wetness', 0, this.wetTex[cur]);
    u1f(gl, this.wetDiffProg, 'u_spread',          p.spread);
    u1f(gl, this.wetDiffProg, 'u_evaporation',     p.evaporation);
    u1f(gl, this.wetDiffProg, 'u_dt',              scaledDT);
    u1f(gl, this.wetDiffProg, 'u_dt_dry',          dt); 
    u1f(gl, this.wetDiffProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.wetDiffProg, 'u_seed',            p.seed);
    u2f(gl, this.wetDiffProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();

    // 2. Pigment Dissolve & Transport
    gl.useProgram(this.fixedPigSubProg);
    this.setViewport(this.fixedPigFB[next]);
    bindTex(gl, this.fixedPigSubProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.fixedPigSubProg, 'u_fixed_pigment', 1, this.fixedPigTex[cur]);
    u1f(gl, this.fixedPigSubProg, 'u_dt',             scaledDT);
    u1f(gl, this.fixedPigSubProg, 'u_dissolve_rate',  p.dissolveRate);
    this.drawQuad();

    gl.useProgram(this.pigDissolveProg);
    this.setViewport(this.pigFB[next]); 
    bindTex(gl, this.pigDissolveProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigDissolveProg, 'u_pigment', 1, this.pigTex[cur]);
    bindTex(gl, this.pigDissolveProg, 'u_fixed_pigment', 2, this.fixedPigTex[cur]);
    u1f(gl, this.pigDissolveProg, 'u_dt',             scaledDT);
    u1f(gl, this.pigDissolveProg, 'u_dissolve_rate',  p.dissolveRate);
    u2f(gl, this.pigDissolveProg, 'u_resolution',    this.width, this.height);
    this.drawQuad();

    gl.useProgram(this.pigDiffProg);
    this.setViewport(this.pigFB[cur]);
    bindTex(gl, this.pigDiffProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigDiffProg, 'u_pigment', 1, this.pigTex[next]);
    u1f(gl, this.pigDiffProg, 'u_spread',          p.spread);
    u1f(gl, this.pigDiffProg, 'u_dt',              scaledDT);
    u1f(gl, this.pigDiffProg, 'u_water_boost',     1.0 + p.waterAmount * 0.5);
    u1f(gl, this.pigDiffProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.pigDiffProg, 'u_seed',            p.seed);
    u2f(gl, this.pigDiffProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();

    gl.useProgram(this.pigGranulationProg);
    this.setViewport(this.pigFB[next]);
    bindTex(gl, this.pigGranulationProg, 'u_pigment', 0, this.pigTex[cur]);
    bindTex(gl, this.pigGranulationProg, 'u_background', 1, this.backgroundTex);
    u1f(gl, this.pigGranulationProg, 'u_granulation_strength', p.granulation);
    u1f(gl, this.pigGranulationProg, 'u_dt', scaledDT);
    this.drawQuad();

    // 3. Fixing
    gl.useProgram(this.pigFixProg);
    this.setViewport(this.fixedPigFB[cur]);
    bindTex(gl, this.pigFixProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigFixProg, 'u_pigment', 1, this.pigTex[next]);
    bindTex(gl, this.pigFixProg, 'u_fixed_pigment', 2, this.fixedPigTex[next]);
    u1f(gl, this.pigFixProg, 'u_dt',          scaledDT);
    this.drawQuad();

    gl.useProgram(this.pigSubProg);
    this.setViewport(this.pigFB[cur]);
    bindTex(gl, this.pigSubProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigSubProg, 'u_pigment', 1, this.pigTex[next]);
    u1f(gl, this.pigSubProg, 'u_dt',          scaledDT);
    this.drawQuad();

    this.blitTex(this.wetTex[next], this.wetFB[cur]);
    this.blitTex(this.fixedPigTex[cur], this.fixedPigFB[next]);
    this.blitTex(this.pigTex[cur], this.pigFB[next]);

    this.currentIdx = next;
  }

  public fixAllPigment() {
    const gl = this.gl;
    const cur = this.currentIdx;
    const next = 1 - cur;

    gl.useProgram(this.pigFixAllProg);
    this.setViewport(this.fixedPigFB[next]);
    bindTex(gl, this.pigFixAllProg, 'u_active', 0, this.pigTex[cur]);
    bindTex(gl, this.pigFixAllProg, 'u_fixed', 1, this.fixedPigTex[cur]);
    this.drawQuad();

    this.blitTex(this.fixedPigTex[next], this.fixedPigFB[cur]);

    const fbs = [this.wetFB[0], this.wetFB[1], this.pigFB[0], this.pigFB[1]];
    fbs.forEach(fb => this.clearFB(fb));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  public interact(p: SimulationParams, dt: number) {
    const gl = this.gl;
    const cur  = this.currentIdx;
    const next = 1 - cur;
    const mx   = p.mousePos[0];
    const my   = this.height - p.mousePos[1];

    const timeScale = dt * 60.0;

    if (!p.isMouseDown) {
      this.prevMousePos = null;
      return;
    }

    const points: [number, number][] = [];
    if (this.prevMousePos) {
      const dx = mx - this.prevMousePos[0];
      const dy = my - this.prevMousePos[1];
      const dist = Math.sqrt(dx * dx + dy * dy);
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

      // Wetness
      gl.useProgram(this.wetInterProg);
      this.setViewport(this.wetFB[next]);
      bindTex(gl, this.wetInterProg, 'u_wetness', 0, this.wetTex[cur]);
      u2f(gl, this.wetInterProg, 'u_mouse',      px, py);
      u1f(gl, this.wetInterProg, 'u_radius',     p.brushSize);
      u1f(gl, this.wetInterProg, 'u_water',      p.waterAmount * timeScale);
      u1f(gl, this.wetInterProg, 'u_force',      p.injectionForce);
      u2f(gl, this.wetInterProg, 'u_resolution', this.width, this.height);
      this.drawQuad();
      this.blitTex(this.wetTex[next], this.wetFB[cur]);

      // Pigment
      if (!p.waterOnly) {
        gl.useProgram(this.pigInterProg);
        this.setViewport(this.pigFB[next]);
        bindTex(gl, this.pigInterProg, 'u_pigment', 0, this.pigTex[cur]);
        u2f(gl, this.pigInterProg, 'u_mouse',      px, py);
        u1f(gl, this.pigInterProg, 'u_radius',     p.brushSize);
        u3f(gl, this.pigInterProg, 'u_color', p.pigmentColor[0], p.pigmentColor[1], p.pigmentColor[2]);
        u1f(gl, this.pigInterProg, 'u_density',    p.pigmentColor[3] * timeScale);
        u1f(gl, this.pigInterProg, 'u_force',      p.injectionForce);
        u2f(gl, this.pigInterProg, 'u_resolution', this.width, this.height);
        this.drawQuad();
        this.blitTex(this.pigTex[next], this.pigFB[cur]);
      }
    }
  }

  public render(p: SimulationParams) {
    const gl = this.gl;
    const cur = this.currentIdx;
    gl.useProgram(this.renderProg);
    this.setViewport(null);
    bindTex(gl, this.renderProg, 'u_wetness',       0, this.wetTex[cur]);
    bindTex(gl, this.renderProg, 'u_pigment',       1, this.pigTex[cur]);
    bindTex(gl, this.renderProg, 'u_fixed_pigment', 2, this.fixedPigTex[cur]);
    bindTex(gl, this.renderProg, 'u_background',    3, this.backgroundTex);
    
    u1f(gl, this.renderProg, 'u_granulation',      p.granulation);
    u1f(gl, this.renderProg, 'u_edge_darkening',  p.edgeDarkening);
    u1f(gl, this.renderProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.renderProg, 'u_seed',            p.seed);
    u2f(gl, this.renderProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();
  }

  public clear() {
    this.currentIdx = 0;
    this.prevMousePos = null;
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

  public importImage(img: HTMLImageElement) {
    const gl = this.gl;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const ctx = tempCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, this.width, this.height);

    const scale = Math.min(this.width / img.width, this.height / img.height);
    const nw = img.width * scale;
    const nh = img.height * scale;
    const nx = (this.width - nw) / 2;
    const ny = (this.height - nh) / 2;

    ctx.drawImage(img, nx, ny, nw, nh);
    const imageData = ctx.getImageData(0, 0, this.width, this.height);
    const pixels = imageData.data;

    const floatPixels = new Float32Array(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const srcIdx = (y * this.width + x) * 4;
        const dstIdx = ((this.height - 1 - y) * this.width + x) * 4;
        const r = pixels[srcIdx]   / 255.0;
        const g = pixels[srcIdx+1] / 255.0;
        const b = pixels[srcIdx+2] / 255.0;
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const density = Math.max(0.0, 1.0 - luminance);
        floatPixels[dstIdx]   = r * density;
        floatPixels[dstIdx+1] = g * density;
        floatPixels[dstIdx+2] = b * density;
        floatPixels[dstIdx+3] = density;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this.fixedPigTex[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, floatPixels);
    gl.bindTexture(gl.TEXTURE_2D, this.fixedPigTex[1]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, floatPixels);
    
    const fbsToClear = [this.wetFB[0], this.wetFB[1], this.pigFB[0], this.pigFB[1]];
    fbsToClear.forEach(fb => this.clearFB(fb));
  }

  public saveUndoState() {
    this.blitTex(this.wetTex[this.currentIdx], this.undoWetFB);
    this.blitTex(this.pigTex[this.currentIdx], this.undoPigFB);
    this.blitTex(this.fixedPigTex[this.currentIdx], this.undoFixedPigFB);
  }

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
