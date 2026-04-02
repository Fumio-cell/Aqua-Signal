// VERTEX SHADER: Simple Quad
export const VERT_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const COMMON_LIBS = `
// 黄金比を用いた高品質擬似乱数 (キャンバス座標依存)
float gold_noise(vec2 seed, float p) {
  return fract(tan(distance(seed * 1.61803398874989484820459 * p, seed)) * seed.x);
}
`;

// ============================================================
//  WET_DIFFUSE_FRAG: 水分拡散 (毛細管現象 + 質量保存膨張)
// ============================================================
export const WET_DIFFUSE_FRAG = `#version 300 es
precision highp float;
${COMMON_LIBS}
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform float u_spread;
uniform float u_evaporation;
uniform float u_dt;
uniform float u_dt_dry;
uniform float u_paper_roughness;
uniform float u_seed;
uniform vec2 u_resolution;
in vec2 v_uv; out vec4 out_col;

void main() {
  vec2 px = 1.0 / u_resolution;
  float c = texture(u_wetness, v_uv).r;

  // 隣接セルの実際の水分量
  float cu = texture(u_wetness, v_uv + vec2(0, px.y)).r;
  float cd = texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float cl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float cr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;

  // 繊維の抵抗感
  float n = gold_noise(v_uv, u_seed);
  float f = 1.0 + (n * 2.0 - 1.0) * u_paper_roughness * 0.15;

  // ---- 質量保存型フラックス計算 ----
  // 滲み効率を 0.45 へ引き上げ (高速化)
  float baseFlow = u_spread * u_dt * 0.45;
  
  // 膨張圧力: 4.5倍 (筆を置いた瞬間の爆発的な滲みを実現)
  float innerPush = 4.5;
  float pushU = mix(1.0, innerPush, step(cu, 0.001));
  float pushD = mix(1.0, innerPush, step(cd, 0.001));
  float pushL = mix(1.0, innerPush, step(cl, 0.001));
  float pushR = mix(1.0, innerPush, step(cr, 0.001));

  // 流出量
  float flowU = c * baseFlow * pushU * f;
  float flowD = c * baseFlow * pushD * f;
  float flowL = c * baseFlow * pushL * f;
  float flowR = c * baseFlow * pushR * f;

  // 流入量
  float inU = cu * baseFlow * mix(1.0, innerPush, step(c, 0.001)) * f;
  float inD = cd * baseFlow * mix(1.0, innerPush, step(c, 0.001)) * f;
  float inL = cl * baseFlow * mix(1.0, innerPush, step(c, 0.001)) * f;
  float inR = cr * baseFlow * mix(1.0, innerPush, step(c, 0.001)) * f;

  float w = c + (inU + inD + inL + inR) - (flowU + flowD + flowL + flowR);

  // ---- 乾燥・蒸発 ----
  float drain = c * u_evaporation * u_dt_dry;
  w = max(0.0, w - drain);

  out_col = vec4(clamp(w, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

// ============================================================
//  PIGMENT – DIFFUSE (顔料の拡散：隣接セル間の平均化)
// ============================================================
export const PIG_DIFFUSE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform float u_spread;
uniform float u_dt;
uniform float u_water_boost;
uniform vec2 u_resolution;
in vec2 v_uv; out vec4 out_col;

void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 c = texture(u_pigment, v_uv);
  float w_c = texture(u_wetness, v_uv).r;

  float moveFactor = u_spread * 0.015 * u_dt * smoothstep(0.02, 0.18, w_c) * u_water_boost;
  if (moveFactor < 0.0001) { out_col = c; return; }

  vec4 pu = texture(u_pigment, v_uv + vec2(0,  px.y));
  vec4 pd = texture(u_pigment, v_uv - vec2(0,  px.y));
  vec4 pl = texture(u_pigment, v_uv - vec2(px.x, 0));
  vec4 pr = texture(u_pigment, v_uv + vec2(px.x, 0));

  float lapA = pu.a + pd.a + pl.a + pr.a - 4.0 * c.a;
  float newA = clamp(c.a + lapA * moveFactor, 0.0, 1.0);
  
  vec3 lapRGB = pu.rgb + pd.rgb + pl.rgb + pr.rgb - 4.0 * c.rgb;
  vec3 newRGB = c.rgb + lapRGB * moveFactor;
  if (newA > 0.0001) newRGB = clamp(newRGB, vec3(0.0), vec3(newA));
  else newRGB = vec3(0.0);
  
  out_col = vec4(newRGB, newA);
}
`;

// ============================================================
//  PIGMENT – FIXING (顔料の定着：水分に比例して背景へ移行)
// ============================================================
export const PIG_FIX_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform sampler2D u_fixed_pigment;
uniform float u_dt;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 pig = texture(u_pigment, v_uv);
  vec4 fixedPig = texture(u_fixed_pigment, v_uv);
  float fixRate = smoothstep(0.08, 0.02, w) * clamp(u_dt * 5.0, 0.0, 1.0); 
  
  vec4 newlyFixed = vec4(pig.rgb * fixRate, pig.a * fixRate);
  vec4 res = fixedPig + newlyFixed;
  if(res.a > 1.0) {
      res.rgb *= (1.0 / res.a);
      res.a = 1.0;
  }
  out_col = res;
}
`;

// ============================================================
//  PIGMENT – SUBTRACTION (定着した分をActiveから引く)
// ============================================================
export const PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 pig = texture(u_pigment, v_uv);
  float fixRate = smoothstep(0.08, 0.02, w); 
  out_col = pig * (1.0 - fixRate);
}
`;

// ============================================================
//  PIGMENT – FIX ALL (強制定着：フリーズ時に使用)
// ============================================================
export const PIG_FIX_ALL_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_active;
uniform sampler2D u_fixed;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec4 a = texture(u_active, v_uv);
  vec4 f = texture(u_fixed, v_uv);
  vec4 res = f + a;
  if (res.a > 1.0) {
      res.rgb *= (1.0 / res.a);
      res.a = 1.0;
  }
  out_col = res;
}
`;

// ============================================================
//  PIGMENT – DISSOLVE / FIXED_SUBTRACT (溶解)
// ============================================================
export const PIG_DISSOLVE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform sampler2D u_fixed_pigment;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 p = texture(u_pigment, v_uv);
  vec4 fp = texture(u_fixed_pigment, v_uv);
  float dr = (w >= 0.65) ? smoothstep(0.65, 0.95, w) * 0.02 : 0.0;
  out_col = p + fp * dr;
}
`;

export const FIXED_PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_fixed_pigment;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 fp = texture(u_fixed_pigment, v_uv);
  float dr = (w >= 0.65) ? smoothstep(0.65, 0.95, w) * 0.02 : 0.0;
  out_col = fp * (1.0 - dr);
}
`;

// ============================================================
//  WETNESS / PIGMENT INTERACTION
// ============================================================
export const WET_INTERACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform vec2 u_mouse;
uniform float u_radius;
uniform float u_water;
uniform float u_force;
uniform vec2 u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec2 px = v_uv * u_resolution;
  float d = distance(px, u_mouse);
  float f = clamp(1.0 - d/u_radius, 0.0, 1.0);
  float prev = texture(u_wetness, v_uv).r;
  out_col = vec4(clamp(prev + u_water * f * u_force, 0.0, 1.0), 0, 0, 1);
}
`;

export const PIG_INTERACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_pigment;
uniform vec2 u_mouse;
uniform float u_radius;
uniform vec3 u_color;
uniform float u_density;
uniform float u_force;
uniform vec2 u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec2 px = v_uv * u_resolution;
  float d = distance(px, u_mouse);
  float f = clamp(1.0 - d/u_radius, 0.0, 1.0);
  vec4 prev = texture(u_pigment, v_uv);
  float addA = u_density * f * u_force;
  vec3 newColor = mix(prev.rgb/(prev.a+0.0001), u_color, addA/(prev.a+addA+0.0001));
  float newA = clamp(prev.a + addA, 0.0, 1.0);
  out_col = vec4(newColor * newA, newA);
}
`;

// ============================================================
//  RENDER SHADER (最終描画)
// ============================================================
export const RENDER_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform sampler2D u_fixed_pigment;
uniform float u_granulation;
uniform float u_edge_darkening;
uniform float u_paper_roughness;
uniform float u_seed;
uniform vec2 u_resolution;
in vec2 v_uv; out vec4 out_color;

${COMMON_LIBS}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}

void main() {
  float wet = texture(u_wetness, v_uv).r;
  vec4 a = texture(u_pigment, v_uv);
  vec4 f = texture(u_fixed_pigment, v_uv);
  
  float density = clamp(a.a + f.a, 0.0, 1.0);
  vec3 pigCol = (density > 0.001) ? (a.rgb + f.rgb) / density : vec3(0.0);
  
  vec3 paperColor = vec3(0.97, 0.96, 0.94);
  float n = noise(v_uv * 300.0 + u_seed);
  float grain = 1.0 + (n - 0.5) * u_granulation * 0.4 * u_paper_roughness;
  
  float alpha = smoothstep(0.01, 0.3, density * grain);
  
  vec3 result = mix(paperColor, pigCol, alpha);
  
  // Edge darkening
  vec2 px = 1.0 / u_resolution;
  float wdx = texture(u_wetness, v_uv + vec2(px.x, 0)).r - texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float wdy = texture(u_wetness, v_uv + vec2(0, px.y)).r - texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float edge = length(vec2(wdx, wdy)) * smoothstep(0.1, 0.0, wet) * u_edge_darkening * 15.0;
  result *= (1.0 - edge * alpha);
  
  out_color = vec4(result, 1.0);
}
`;

// ============================================================
//  BLIT
// ============================================================
export const BLIT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
in vec2 v_uv; out vec4 out_col;
void main() { out_col = texture(u_src, v_uv); }
`;
