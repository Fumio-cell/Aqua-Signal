import { WebGLUtility } from './WebGLUtility';
import {
  VERT_SHADER,
  WET_DIFFUSE_FRAG,
  PIG_DIFFUSE_FRAG,
  WET_INTERACT_FRAG,
  PIG_INTERACT_FRAG,
  RENDER_FRAG,
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
  gl.uniform1f(gl.getUniformLocation(prog, name), v);
}
function u2f(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, x: number, y: number) {
  gl.uniform2f(gl.getUniformLocation(prog, name), x, y);
}
function u3f(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, x: number, y: number, z: number) {
  gl.uniform3f(gl.getUniformLocation(prog, name), x, y, z);
}
function bindTex(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, unit: number, tex: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, name), unit);
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

  // Undo snapshots
  private undoWetTex: WebGLTexture;
  private undoPigTex: WebGLTexture;
  private undoWetFB: WebGLFramebuffer;
  private undoPigFB: WebGLFramebuffer;

  // Shader programs
  private wetDiffProg: WebGLProgram;
  private pigDiffProg: WebGLProgram;
  private wetInterProg: WebGLProgram;
  private pigInterProg: WebGLProgram;
  private renderProg: WebGLProgram;

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

    // Create programs
    const P = (fs: string) => WebGLUtility.createProgram(gl, VERT_SHADER, fs);
    this.wetDiffProg  = P(WET_DIFFUSE_FRAG);
    this.pigDiffProg  = P(PIG_DIFFUSE_FRAG);
    this.wetInterProg = P(WET_INTERACT_FRAG);
    this.pigInterProg = P(PIG_INTERACT_FRAG);
    this.renderProg   = P(RENDER_FRAG);

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
    u1f(gl, this.wetDiffProg, 'u_dt',              scaledDT);
    u1f(gl, this.wetDiffProg, 'u_paper_roughness', p.paperRoughness);
    u1f(gl, this.wetDiffProg, 'u_seed',            p.seed);
    u1f(gl, this.wetDiffProg, 'u_dissolve_dry',    p.waterOnly ? 1.0 : 0.0);
    u2f(gl, this.wetDiffProg, 'u_resolution',      this.width, this.height);
    this.drawQuad();

    // 2. Advect pigment (only where wet)
    gl.useProgram(this.pigDiffProg);
    this.setViewport(this.pigFB[next]);
    bindTex(gl, this.pigDiffProg, 'u_wetness', 0, this.wetTex[cur]);
    bindTex(gl, this.pigDiffProg, 'u_pigment', 1, this.pigTex[cur]);
    u1f(gl, this.pigDiffProg, 'u_spread',      p.spread);
    u1f(gl, this.pigDiffProg, 'u_dt',          scaledDT);
    u1f(gl, this.pigDiffProg, 'u_water_boost', p.waterOnly ? 6.0 : 1.0);
    u2f(gl, this.pigDiffProg, 'u_resolution',  this.width, this.height);
    this.drawQuad();

    this.currentIdx = next;
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

    this.currentIdx = next;
  }

  /** Render to screen */
  public render(p: SimulationParams) {
    const gl = this.gl;
    this.setViewport(null);
    gl.useProgram(this.renderProg);
    bindTex(gl, this.renderProg, 'u_wetness', 0, this.wetTex[this.currentIdx]);
    bindTex(gl, this.renderProg, 'u_pigment', 1, this.pigTex[this.currentIdx]);
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
  }

  /** Restore undo snapshot */
  public restoreUndoState() {
    this.blitTex(this.undoWetTex, this.wetFB[this.currentIdx]);
    this.blitTex(this.undoPigTex, this.pigFB[this.currentIdx]);
  }

  private blitTex(src: WebGLTexture, dstFB: WebGLFramebuffer) {
    const gl = this.gl;
    // Simple passthrough draw
    const prog = WebGLUtility.createProgram(gl, VERT_SHADER,
      `#version 300 es
       precision highp float;
       uniform sampler2D u_src;
       in vec2 v_uv; out vec4 o;
       void main() { o = texture(u_src, v_uv); }`);
    gl.useProgram(prog);
    this.setViewport(dstFB);
    bindTex(gl, prog, 'u_src', 0, src);
    this.drawQuad();
    gl.deleteProgram(prog);
  }

  /** Clear all state */
  public reset() {
    const gl = this.gl;
    const fbs = [
      this.wetFB[0], this.wetFB[1],
      this.pigFB[0], this.pigFB[1],
      this.undoWetFB, this.undoPigFB,
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
