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
  private pigFixProg: WebGLProgram;
  private pigSubProg: WebGLProgram;
  private pigDissolveProg: WebGLProgram;
  private fixedPigSubProg: WebGLProgram;
  private pigFixAllProg: WebGLProgram;
  private renderProg: WebGLProgram;
  private blitProg: WebGLProgram;

  private vao: WebGLVertexArrayObject;
  private currentIdx = 0;

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

  private drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private setViewport(fb: WebGLFramebuffer | null) {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fb);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  // ---- Public API ----

  /** Advance simulation one timestep */
  public step(p: SimulationParams, dt: number) {
    const gl = this.gl;
    const cur  = this.currentIdx;
    const next = 1 - cur;
    const scaledDT = dt * p.flowSpeed;

    // 1. Diffuse wetness (with paper permeability + settled-pigment blocking)
    gl.useProgram(this.wetDiffProg);
    this.setViewport(this.wetFB[next]);
    bindTex(gl, this.wetDiffProg, 'u_wetness', 0, this.wetTex[cur]);
    bindTex(gl, this.wetDiffProg, 'u_pigment', 1, this.pigTex[cur]);
    u1f(gl, this.wetDiffProg, 'u_spread',          p.spread);
    u1f(gl, this.wetDiffProg, 'u_evaporation',     p.evaporation);
    // 広がる速度 (dt * flowSpeed) と 乾燥速度 (dt) を分離
    u1f(gl, this.wetDiffProg, 'u_dt',              scaledDT);
    u1f(gl, this.wetDiffProg, 'u_dt_dry',          dt); 
    u1f(gl, this.wetDiffProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.wetDiffProg, 'u_seed',            p.seed);
    u1f(gl, this.wetDiffProg, 'u_dissolve_dry',    p.waterOnly ? 1.0 : 0.0);
    u2f(gl, this.wetDiffProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();

    // --------------------------------------------------------
    // PIGMENT Sequential Pipeline (Cur -> Next -> Cur -> Next)
    // --------------------------------------------------------
    
    // Pass 1: Re-wetting / Dissolve (F -> A)
    // Source: Active[cur], Fixed[cur] -> Target: Active[next], Fixed[next]
    gl.useProgram(this.pigDissolveProg);
    this.setViewport(this.pigFB[next]);
    bindTex(gl, this.pigDissolveProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigDissolveProg, 'u_pigment', 1, this.pigTex[cur]);
    bindTex(gl, this.pigDissolveProg, 'u_fixed_pigment', 2, this.fixedPigTex[cur]);
    u2f(gl, this.pigDissolveProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    gl.useProgram(this.fixedPigSubProg);
    this.setViewport(this.fixedPigFB[next]);
    bindTex(gl, this.fixedPigSubProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.fixedPigSubProg, 'u_fixed_pigment', 1, this.fixedPigTex[cur]);
    this.drawQuad();

    // Pass 2: Pigment Diffusion
    // Source: Active[next] -> Target: Active[cur] (use cur as temp)
    gl.useProgram(this.pigDiffProg);
    this.setViewport(this.pigFB[cur]);
    bindTex(gl, this.pigDiffProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigDiffProg, 'u_pigment', 1, this.pigTex[next]);
    u1f(gl, this.pigDiffProg, 'u_spread',      p.spread);
    u1f(gl, this.pigDiffProg, 'u_dt',          scaledDT);
    u1f(gl, this.pigDiffProg, 'u_water_boost', p.waterOnly ? 6.0 : 1.0);
    u2f(gl, this.pigDiffProg, 'u_resolution',  this.width, this.height);
    this.drawQuad();

    // Pass 3: Fix pigment (Active -> Fixed)
    // Source: Active[cur], Fixed[next] -> Target: Fixed[next] (update in place is not possible, so write to Fixed[cur])
    gl.useProgram(this.pigFixProg);
    this.setViewport(this.fixedPigFB[cur]);
    bindTex(gl, this.pigFixProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigFixProg, 'u_pigment', 1, this.pigTex[cur]);
    bindTex(gl, this.pigFixProg, 'u_fixed_pigment', 2, this.fixedPigTex[next]);
    u1f(gl, this.pigFixProg, 'u_dt', scaledDT);
    u2f(gl, this.pigFixProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    // Pass 4: Finalize Active (Subtract fixed part)
    // Source: Active[cur], Wet[next] -> Target: Active[next]
    gl.useProgram(this.pigSubProg);
    this.setViewport(this.pigFB[next]);
    bindTex(gl, this.pigSubProg, 'u_wetness', 0, this.wetTex[next]);
    bindTex(gl, this.pigSubProg, 'u_pigment', 1, this.pigTex[cur]);
    u2f(gl, this.pigSubProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    // 不要な Blit を完全に廃止。
    // Fixed の同期は定着・溶解イベントが発生した際のみ実行されるように修正。
    // これにより定着済みエリアの1bit単位での静止を保証。

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

  /** Inject water + pigment at mouse position */
  public interact(p: SimulationParams) {
    const gl = this.gl;
    const cur  = this.currentIdx;
    const next = 1 - cur;
    const mx   = p.mousePos[0];
    const my   = this.height - p.mousePos[1]; // flip Y

    // 3. Inject wetness
    gl.useProgram(this.wetInterProg);
    this.setViewport(this.wetFB[next]);
    bindTex(gl, this.wetInterProg, 'u_wetness', 0, this.wetTex[cur]);
    u2f(gl, this.wetInterProg, 'u_mouse',      mx, my);
    u1f(gl, this.wetInterProg, 'u_radius',     p.brushSize);
    u1f(gl, this.wetInterProg, 'u_water',      p.waterAmount);
    u1f(gl, this.wetInterProg, 'u_force',      p.injectionForce);
    u2f(gl, this.wetInterProg, 'u_resolution', this.width, this.height);
    this.drawQuad();

    // 4. Inject pigment (水のみモードでは顔料をスキップ)
    if (!p.waterOnly) {
      gl.useProgram(this.pigInterProg);
      this.setViewport(this.pigFB[next]);
      bindTex(gl, this.pigInterProg, 'u_pigment', 0, this.pigTex[cur]);
      u2f(gl, this.pigInterProg, 'u_mouse',      mx, my);
      u1f(gl, this.pigInterProg, 'u_radius',     p.brushSize);
      u3f(gl, this.pigInterProg, 'u_color',
        p.pigmentColor[0], p.pigmentColor[1], p.pigmentColor[2]);
      u1f(gl, this.pigInterProg, 'u_density',    p.pigmentColor[3]);
      u1f(gl, this.pigInterProg, 'u_force',      p.injectionForce);
      u2f(gl, this.pigInterProg, 'u_resolution', this.width, this.height);
      this.drawQuad();
    } else {
      // waterOnly: pigment バッファを次フレームへそのままコピー
      this.blitTex(this.pigTex[cur], this.pigFB[next]);
    }
    
    // 操作時はバッファを強制同期させる (Sync Fixed)
    for (let i = 0; i < 2; i++) {
        this.blitTex(this.fixedPigTex[cur], this.fixedPigFB[i]);
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

  /** Save undo snapshot (call before new stroke) */
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
    // 使用済みのプログラムを使いまわし
    gl.useProgram(this.blitProg);
    this.setViewport(dstFB);
    bindTex(gl, this.blitProg, 'u_src', 0, src);
    this.drawQuad();
  }

  /** Clear all state */
  public reset() {
    const gl = this.gl;
    const fbs = [
      this.wetFB[0], this.wetFB[1],
      this.pigFB[0], this.pigFB[1],
      this.fixedPigFB[0], this.fixedPigFB[1],
      this.undoWetFB, this.undoPigFB,
      this.undoFixedPigFB,
    ];
    fbs.forEach(fb => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.currentIdx = 0;
  }
}
