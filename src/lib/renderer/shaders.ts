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
// 滑らかな波ベースのノイズ (PDE用)
float wave_noise(vec2 p, float seed) {
  vec2 p1 = p * 8.324 + seed;
  vec2 p2 = p * 11.751 - seed * 0.7;
  float n1 = sin(p1.x) * cos(p1.y);
  float n2 = sin(p2.x + p2.y * 1.3) * cos(p2.y - p2.x * 0.8);
  return (n1 + n2) * 0.25 + 0.5; // [0, 1]
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

  // Use smooth wave noise instead of high-frequency white noise for physical flow
  float f = mix(0.9, 1.1, wave_noise(v_uv, u_seed));

  // 隣接セルの水分量
  float cu = texture(u_wetness, v_uv + vec2(0, px.y)).r;
  float cd = texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float cl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float cr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;

  // ---- 圧力勾配モデル (Pressure Gradient Flow) ----
  float p_c = pow(max(0.0, c), 1.5);
  float p_u = pow(max(0.0, cu), 1.5);
  float p_d = pow(max(0.0, cd), 1.5);
  float p_l = pow(max(0.0, cl), 1.5);
  float p_r = pow(max(0.0, cr), 1.5);

  // 安定条件のため、セルの流出合計が100%を超えないよう厳格にキャップする (max 0.20 per neighbor)
  float baseFlow = min(u_spread * u_dt * 0.15, 0.2);
  float push = 1.0; 
  float pU = mix(1.0, push * f, smoothstep(0.005, 0.02, cu));
  float pD = mix(1.0, push * f, smoothstep(0.005, 0.02, cd));
  float pL = mix(1.0, push * f, smoothstep(0.005, 0.02, cl));
  float pR = mix(1.0, push * f, smoothstep(0.005, 0.02, cr));

  float flowU = max(0.0, p_c - p_u) * baseFlow * pU;
  float flowD = max(0.0, p_c - p_d) * baseFlow * pD;
  float flowL = max(0.0, p_c - p_l) * baseFlow * pL;
  float flowR = max(0.0, p_c - p_r) * baseFlow * pR;

  float inU = max(0.0, p_u - p_c) * baseFlow * mix(1.0, push * f, smoothstep(0.005, 0.02, c));
  float inD = max(0.0, p_d - p_c) * baseFlow * mix(1.0, push * f, smoothstep(0.005, 0.02, c));
  float inL = max(0.0, p_l - p_c) * baseFlow * mix(1.0, push * f, smoothstep(0.005, 0.02, c));
  float inR = max(0.0, p_r - p_c) * baseFlow * mix(1.0, push * f, smoothstep(0.005, 0.02, c));

  float w = c + (inU + inD + inL + inR) - (flowU + flowD + flowL + flowR);

  // ---- 非線形蒸発モデル ----
  float drain = c * u_evaporation * u_dt_dry * smoothstep(0.0, 0.1, c);
  w = max(0.0, w - drain);

  out_col = vec4(clamp(w, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

// ============================================================
//  PIG_DIFFUSE_FRAG: 顔料の拡散 (移流強化版 - Tide Mark 対応)
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

  // Use smooth wave noise instead of high-frequency white noise for continuous diffusion
  float kasureFactor = mix(0.8, 1.2, wave_noise(v_uv * 2.0, u_seed));

  // ---- 顔料の移流 (Advection) ----
  float wu = texture(u_wetness, v_uv + vec2(0, px.y)).r;
  float wd = texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float wl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float wr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;
  
  vec2 gradW = vec2(wr - wl, wu - wd);
  float speed = length(gradW);
  
  // 渦(Curl)ノイズによる混色のための乱気流 (細かく無数にうねる局所的なマイクロ渦に変更)
  // これにより一方向に全インクが押し流されて真空の白抜け穴が開くのを完全に防止する
  float nx = wave_noise(v_uv * 45.0 + u_seed, 0.0) - 0.5;
  float ny = wave_noise(v_uv * 45.0 - u_seed, 1.0) - 0.5;
  vec2 curl = vec2(ny, -nx);
  
  // 【白抜け完全防止】水分の勾配（-gradW）による「顔料の押し出し」が強すぎると、筆の中心が空っぽになり紙の白が露出してしまう。
  // 押し出しを完全に無効化(0.01)に近くし、純粋なマイクロ渦(Curl)だけで「色が削れないまま混ざる(Smudge)」ようにする！
  float radialFlow = 1.0 - smoothstep(0.3, 0.9, w_c) * 0.9;
  vec2 physVel = (-gradW * 0.01 * radialFlow + curl * 0.8) * 0.12;
  
  // 潮汐跡 (Tide Mark): ユーザーの希望により、乾き際のフチ（エッジ）へ顔料を強く押し流して黒ずませる物理的な力を完全削除
  vec2 totalVel = physVel;
  
  float viscosity = smoothstep(0.1, 1.0, c.a);
  // Backward semi-Lagrangian tracing: 適度な速度で色が混ざり合いながらにじむ
  vec2 offset = -totalVel * u_spread * 0.2 * u_dt * kasureFactor;
  offset *= (1.0 - viscosity * 0.6);
  
  offset = clamp(offset, -6.0 * px, 6.0 * px);
  vec4 advected = texture(u_pigment, v_uv + offset);
  advected = mix(c, advected, 0.65); // 色が溶け合いながら移動する

  // ---- 拡散 (Diffusion) ----
  // 【真空化防止】拡散速度を0.02へと極限まで抑制し、筆の中心から顔料が吸い出されて空っぽの穴になる問題を防ぐ
  float moveFactor = u_spread * 0.02 * u_dt * smoothstep(0.001, 0.1, w_c) * u_water_boost * kasureFactor;
  // 【致命的バグ修正】拡散係数が0.25を超えるとラプラシアンフィルタが発散し、市松模様のノイズバグが発生するのを防ぐ
  moveFactor = min(moveFactor, 0.24);
  
  vec4 pu = texture(u_pigment, v_uv + vec2(0,  px.y));
  vec4 pd = texture(u_pigment, v_uv - vec2(0,  px.y));
  vec4 pl = texture(u_pigment, v_uv - vec2(px.x, 0));
  vec4 pr = texture(u_pigment, v_uv + vec2(px.x, 0));

  float lapA = pu.a + pd.a + pl.a + pr.a - 4.0 * c.a;
  float newA = clamp(advected.a + lapA * moveFactor, 0.0, 5.0);
  
  vec3 lapRGB = pu.rgb + pd.rgb + pl.rgb + pr.rgb - 4.0 * c.rgb;
  vec3 newRGB = advected.rgb + lapRGB * moveFactor;
  
  if (newA > 0.0001) newRGB = clamp(newRGB, vec3(0.0), vec3(newA));
  else newRGB = vec3(0.0);
  
  out_col = vec4(newRGB, newA);
}
`;

// ============================================================
//  PIGMENT – FIXING (顔料の定着)
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
  
  float fixRate = smoothstep(0.05, 0.0, w); 
  // 水があっても徐々に定着する成分。u_dt=2.5 の環境下で 0.0025 程度にする
  float instantFix = 0.001 * u_dt;
  fixRate = clamp(fixRate + instantFix, 0.0, 1.0);
  if (w <= 0.0001) fixRate = 1.0; 

  vec4 newlyFixed = vec4(pig.rgb * fixRate, pig.a * fixRate);
  vec4 res = fixedPig + newlyFixed;
  res.a = min(res.a, 5.0);
  out_col = res;
}
`;

export const PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform float u_dt;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 pig = texture(u_pigment, v_uv);
  float fixRate = smoothstep(0.05, 0.0, w); 
  float instantFix = 0.001 * u_dt;
  fixRate = clamp(fixRate + instantFix, 0.0, 1.0);
  if (w <= 0.0001) fixRate = 1.0;
  out_col = pig * (1.0 - fixRate);
}
`;

export const PIG_FIX_ALL_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_active;
uniform sampler2D u_fixed;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec4 a = texture(u_active, v_uv);
  vec4 f = texture(u_fixed, v_uv);
  vec4 res = f + a;
  res.a = min(res.a, 5.0);
  out_col = res;
}
`;

// ============================================================
//  PIGMENT – DISSOLVE / RE-ACTIVATION (再活性化)
// ============================================================
export const PIG_DISSOLVE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform sampler2D u_fixed_pigment;
uniform float u_dt;
uniform float u_dissolve_rate;
in vec2 v_uv; out vec4 out_col;
void main() {
  float wet = texture(u_wetness, v_uv).r;
  // 再活性化（Smudge）を確実にするため、大幅に引上げ、瞬時に用紙から色が浮き上がるようにする
  float dissolve = smoothstep(0.01, 0.4, wet) * u_dt * u_dissolve_rate * 2.5;
  vec4 f = texture(u_fixed_pigment, v_uv);
  vec4 p = texture(u_pigment, v_uv);
  
  float lift = min(f.a, dissolve);
  float resA = clamp(p.a + lift, 0.0, 5.0);
  float actualLift = resA - p.a;
  
  // 安全な除算 (max() を用いて確実なゼロ除算・NaN爆発を防止)
  // 【致命的バグ修正】加算されるRGBは、実際に加算成功したAlpha量(actualLift)に厳密に比例させないと、RGB値のみが青天井に膨張し真っ白な発光色（White Blowout）になる
  vec3 moveRGB = (f.a > 0.00001) ? (f.rgb / max(f.a, 0.00001) * actualLift) : vec3(0.0);
  
  vec3 resRGB = p.rgb + moveRGB;
  out_col = vec4(resRGB, resA);
}
`;

export const FIXED_PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_fixed_pigment;
uniform float u_dt;
uniform float u_dissolve_rate;
in vec2 v_uv; out vec4 out_col;
void main() {
  float wet = texture(u_wetness, v_uv).r;
  float dissolve = smoothstep(0.01, 0.4, wet) * u_dt * u_dissolve_rate * 2.5;
  vec4 f = texture(u_fixed_pigment, v_uv);
  float lift = min(f.a, dissolve);
  float newA = max(0.0, f.a - lift);
  
  vec3 newRGB = (f.a > 0.00001) ? (f.rgb * (newA / f.a)) : vec3(0.0);
  out_col = vec4(newRGB, newA);
}
`;

// ============================================================
//  PIGMENT – GRANULATION (粒状化)
// ============================================================
export const PIG_GRANULATION_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_pigment;
uniform sampler2D u_background;
uniform float u_granulation_strength;
uniform float u_dt;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec4 p = texture(u_pigment, v_uv);
  if (p.a < 0.001) { out_col = p; return; }

  // Flat background causes pigment loss; use a neutral 0.5 to prevent global fading
  float height = 0.5;
  float force = (0.5 - height) * u_granulation_strength * p.a * u_dt * 0.05;
  float newA = clamp(p.a + force, 0.0, 5.0);
  
  vec3 newRGB = (p.a > 0.0001) ? (p.rgb * (newA / max(p.a, 0.0001))) : vec3(0.0);
  out_col = vec4(newRGB, newA);
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
  float falloff = pow(clamp(1.0 - d / u_radius, 0.0, 1.0), 3.0);
  float f = falloff * (1.0 + u_force * 0.5);
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
  float f = pow(clamp(1.0 - d/u_radius, 0.0, 1.0), 3.0);
  vec4 prev = texture(u_pigment, v_uv);
  
  float addA = u_density * f * u_force * 0.5; // Increased from 0.12 to give solid base
  float addDensity = addA * 1.0; // Increased from 0.6
  
  float newA = clamp(prev.a + addDensity, 0.0, 5.0);
  float actualAdd = newA - prev.a; // 【致命的バグ修正】上限(5.0)に達した際、RGBのみが加算され続けて真っ白になるのを防ぐ
  vec3 finalRGB = prev.rgb + u_color * actualAdd;
  
  out_col = vec4(finalRGB, newA);
}
`;

export const PIG_FIXED_INTERACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_fixed_pigment;
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
  float f = pow(clamp(1.0 - d/u_radius, 0.0, 1.0), 3.0);
  vec4 prev = texture(u_fixed_pigment, v_uv);
  float addDensity = u_density * f * u_force * 0.072; // Reduced from 1.5 (Match 0.12 * 0.6)
  vec3 finalRGB = prev.rgb + u_color * addDensity;
  float newA = clamp(prev.a + addDensity, 0.0, 5.0); 
  out_col = vec4(finalRGB, newA);
}
`;

// ============================================================
//  RENDER SHADER (最終描画 - VIBRANCY SUBTRACTIVE MODEL)
// ============================================================
export const RENDER_FRAG = `#version 300 es
precision highp float;
${COMMON_LIBS}
uniform sampler2D u_background;
uniform sampler2D u_pigment;
uniform sampler2D u_fixed_pigment;
uniform float u_edge_darkening;
uniform float u_paper_roughness;
uniform float u_seed;
in vec2 v_uv; out vec4 out_col;

void main() {
  vec4 a = texture(u_pigment, v_uv);
  vec4 f = texture(u_fixed_pigment, v_uv);
  vec3 paperBase = texture(u_background, v_uv).rgb;
  
  // 1. Paper texture with high-frequency noise
  float n1 = gold_noise(v_uv * 2.0, u_seed);
  float n2 = gold_noise(v_uv * 8.0, u_seed + 1.5);
  float grain = (n1 * 0.6 + n2 * 0.4 - 0.5) * 0.3 * u_paper_roughness;
  vec3 paper = clamp(paperBase + vec3(grain), 0.0, 1.0);
  
  // 2. Compute edge darkening (Tide Marks)
  vec2 px = 1.0 / vec2(textureSize(u_pigment, 0));
  float aU = texture(u_pigment, v_uv + vec2(0, px.y)).a + texture(u_fixed_pigment, v_uv + vec2(0, px.y)).a;
  float aD = texture(u_pigment, v_uv - vec2(0, px.y)).a + texture(u_fixed_pigment, v_uv - vec2(0, px.y)).a;
  float aL = texture(u_pigment, v_uv - vec2(px.x, 0)).a + texture(u_fixed_pigment, v_uv - vec2(px.x, 0)).a;
  float aR = texture(u_pigment, v_uv + vec2(px.x, 0)).a + texture(u_fixed_pigment, v_uv + vec2(px.x, 0)).a;
  float lapA = abs(aU + aD + aL + aR - 4.0 * (a.a + f.a));
  // Raise threshold so sparse, small dots don't trigger massive edge darkening (black pepper)
  float edgeBoost = smoothstep(0.15, 1.2, lapA) * u_edge_darkening;

  // 3. Subtractive Blending Model (Absorption based)
  //   Light passes through filters: Result = Paper * Filter(Active) * Filter(Fixed)
  
  // Active Pigment filter
  vec3 colA = (a.a > 0.001) ? clamp(a.rgb / max(a.a, 0.0001), 0.0, 1.0) : vec3(1.0);
  // (1.0 - colA) allows pure white ([1,1,1]) to have exactly 0 absorption, rendering it perfectly transparent / clear.
  vec3 filterA = exp(-a.a * (1.0 - colA) * 2.4); 
  
  // Fixed Pigment filter (Portrait/Ink snapshots)
  vec3 colF = (f.a > 0.001) ? clamp(f.rgb / max(f.a, 0.0001), 0.0, 1.0) : vec3(1.0);
  vec3 filterF = exp(-f.a * (1.0 - colF) * 2.4);
  
  // Tide Mark Darkening (ユーザーの希望により、水の広がりを示す黒っぽいエッジを完全に削除)
  vec3 edgeFilter = vec3(1.0);
  
  // 4. Combine all layers subtractively
  vec3 result = paper * filterA * filterF * edgeFilter;
  


  result = mix(result, result * result, u_paper_roughness * 0.1);

  out_col = vec4(clamp(result, 0.0, 1.0), 1.0);
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
