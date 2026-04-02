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
  return fract(tan(distance(seed * 1.61803398874989484820459 * (p + 0.1), seed)) * seed.x);
}
`;

// ============================================================
//  WET_DIFFUSE_FRAG: 水分拡散 (毛細管現象 + 強力な外向き膨張圧)
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

  // 広域的なノイズによる紙の繊維の偏り (Irregularity)
  float n1 = gold_noise(v_uv * 0.5, u_seed);
  float n2 = gold_noise(v_uv * 2.0, u_seed + 0.5);
  float f = 1.0 + (n1 * 0.6 + n2 * 0.4 - 0.5) * u_paper_roughness;

  // 隣接セルの水分量
  float cu = texture(u_wetness, v_uv + vec2(0, px.y)).r;
  float cd = texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float cl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float cr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;

  // ---- 圧力勾配モデル (Pressure Gradient Flow) ----
  // 圧力 P = w^1.5 (非線形な押し出し)
  float p_c = pow(c, 1.5);
  float p_u = pow(cu, 1.5);
  float p_d = pow(cd, 1.5);
  float p_l = pow(cl, 1.5);
  float p_r = pow(cr, 1.5);

  float baseFlow = u_spread * u_dt * 0.6;
  
  // 外向き膨張圧 (乾いている方向へさらに強く押し出す)
  float push = 6.0; 
  float pU = mix(1.0, push * f, step(cu, 0.01));
  float pD = mix(1.0, push * f, step(cd, 0.01));
  float pL = mix(1.0, push * f, step(cl, 0.01));
  float pR = mix(1.0, push * f, step(cr, 0.01));

  // 流束 (Flux)
  float flowU = max(0.0, p_c - p_u) * baseFlow * pU;
  float flowD = max(0.0, p_c - p_d) * baseFlow * pD;
  float flowL = max(0.0, p_c - p_l) * baseFlow * pL;
  float flowR = max(0.0, p_c - p_r) * baseFlow * pR;

  float inU = max(0.0, p_u - p_c) * baseFlow * mix(1.0, push * f, step(c, 0.01));
  float inD = max(0.0, p_d - p_c) * baseFlow * mix(1.0, push * f, step(c, 0.01));
  float inL = max(0.0, p_l - p_c) * baseFlow * mix(1.0, push * f, step(c, 0.01));
  float inR = max(0.0, p_r - p_c) * baseFlow * mix(1.0, push * f, step(c, 0.01));

  float w = c + (inU + inD + inL + inR) - (flowU + flowD + flowL + flowR);

  // ---- 非線形蒸発モデル ----
  float drain = c * u_evaporation * u_dt_dry * smoothstep(0.0, 0.1, c);
  w = max(0.0, w - drain);

  out_col = vec4(clamp(w, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

// ============================================================
//  PIG_DIFFUSE_FRAG: 顔料の拡散 (Laplacian + かすれノイズ)
// ============================================================
export const PIG_DIFFUSE_FRAG = `#version 300 es
precision highp float;
${COMMON_LIBS}
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform float u_spread;
uniform float u_dt;
uniform float u_water_boost;
uniform float u_paper_roughness;
uniform float u_seed;
uniform vec2 u_resolution;
in vec2 v_uv; out vec4 out_col;

void main() {
  vec2 px = 1.0 / u_resolution;
  vec4 c = texture(u_pigment, v_uv);
  float w_c = texture(u_wetness, v_uv).r;

  // かすれ (Kasure): 紙の粗さとノイズによる局所的な拡散抵抗
  float kasure = gold_noise(v_uv, u_seed + 1.23);
  float kasureFactor = mix(1.0, kasure, u_paper_roughness * 0.85);

  // ---- 顔料の移流 (Advection): 水の速い流れに乗って移動する ----
  // 周囲の水分勾配から流れの方向を推定
  float wu = texture(u_wetness, v_uv + vec2(0, px.y)).r;
  float wd = texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float wl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float wr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;
  
  vec2 vel = vec2(wr - wl, wu - wd);
  float speed = length(vel);
  
  // 水が外側に広がっている場合、顔料も外側に強く押し出される
  vec2 offset = -vel * u_spread * 1.5 * u_dt * kasureFactor;
  vec4 advected = texture(u_pigment, v_uv + offset);

  // ---- 拡散 (Diffusion): Laplacian ----
  float moveFactor = u_spread * 0.12 * u_dt * smoothstep(0.001, 0.1, w_c) * u_water_boost * kasureFactor;
  
  vec4 pu = texture(u_pigment, v_uv + vec2(0,  px.y));
  vec4 pd = texture(u_pigment, v_uv - vec2(0,  px.y));
  vec4 pl = texture(u_pigment, v_uv - vec2(px.x, 0));
  vec4 pr = texture(u_pigment, v_uv + vec2(px.x, 0));

  float lapA = pu.a + pd.a + pl.a + pr.a - 4.0 * advected.a;
  float newA = clamp(advected.a + lapA * moveFactor, 0.0, 1.0);
  
  vec3 lapRGB = pu.rgb + pd.rgb + pl.rgb + pr.rgb - 4.0 * advected.rgb;
  vec3 newRGB = advected.rgb + lapRGB * moveFactor;
  
  if (newA > 0.0001) newRGB = clamp(newRGB, vec3(0.0), vec3(newA));
  else newRGB = vec3(0.0);
  
  out_col = vec4(newRGB, newA);
}
`;

// ============================================================
//  PIGMENT – FIXING (顔料の定着：水分がなくなると紙に吸着)
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
  
  // 水分が 0.05 以下で定着開始。0 では 100% 定着。
  // 注意: SUBTRACT側と同じ計算式である必要がある
  float fixRate = smoothstep(0.05, 0.0, w); 
  if (w <= 0.0001) fixRate = 1.0; 

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
//  PIGMENT – SUBTRACTION
// ============================================================
export const PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 pig = texture(u_pigment, v_uv);
  float fixRate = smoothstep(0.05, 0.0, w); 
  if (w <= 0.0001) fixRate = 1.0;
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
//  PIGMENT – DISSOLVE / FIXED_SUBTRACT
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
  float dr = (w >= 0.6) ? smoothstep(0.6, 0.9, w) * 0.03 : 0.0;
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
  float dr = (w >= 0.6) ? smoothstep(0.6, 0.9, w) * 0.03 : 0.0;
  out_col = fp * (1.0 - dr);
}
`;

// ============================================================
//  INTERACTION
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
  
  // 指の動きで水を「押し出す」ような減衰
  float splash = smoothstep(u_radius, 0.0, d);
  float f = splash * (1.0 + u_force * 0.5);
  
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
  
  // 顔料密度
  float density = clamp(a.a + f.a, 0.0, 1.0);
  vec3 pigCol = (density > 0.001) ? (a.rgb + f.rgb) / density : vec3(0.0);
  
  vec3 paperColor = vec3(0.97, 0.96, 0.94);
  float n = noise(v_uv * 300.0 + u_seed);
  float grain = 1.0 + (n - 0.5) * u_granulation * 0.4 * u_paper_roughness;
  
  // 滲みの端を柔らかくしつつ、低密度でも色を残す
  float alpha = smoothstep(0.002, 0.25, density * grain);
  
  vec3 result = mix(paperColor, pigCol, alpha);
  
  // エッジの暗色化 (水分が引く際の顔料溜まり)
  vec2 px = 1.0 / u_resolution;
  float wdx = texture(u_wetness, v_uv + vec2(px.x, 0)).r - texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float wdy = texture(u_wetness, v_uv + vec2(0, px.y)).r - texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float edge = length(vec2(wdx, wdy)) * smoothstep(0.15, 0.0, wet) * u_edge_darkening * 18.0;
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
