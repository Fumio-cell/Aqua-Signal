export const VERT_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// ============================================================
//  COMMON: hash / noise (shared by all fragments via include pattern)
//  実装は各シェーダー内にコピー
// ==================================// ============================================================
//  WETNESS – diffusion pass
//  Resistor Network モデル: 各ボンドに独立ノイズでコンダクタンスを割り当て
//  roughness高いと完全封鎖ボンドが発生 → 指+刺状の外縁形状
// ============================================================
export const WET_DIFFUSE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform float u_spread;
uniform float u_evaporation;
uniform float u_dt;
uniform float u_paper_roughness;
uniform float u_seed;
uniform float u_dissolve_dry; // 1.0 = 水モード：乾燥ロックを解除
uniform vec2  u_resolution;
in vec2 v_uv; out vec4 out_col;

float h2(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * h2(p); p = p * 2.17 + vec2(1.7, 9.2); a *= 0.5; }
  return v;  // 0..1
}

void main() {
  vec2 px = 1.0 / u_resolution;
  vec2 pp = v_uv * u_resolution;  // pixel position
  float c = texture(u_wetness, v_uv).r;

  float cu = texture(u_wetness, v_uv + vec2(0, px.y)).r;
  float cd = texture(u_wetness, v_uv - vec2(0, px.y)).r;
  float cl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float cr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;

  // 乾燥定着覆料エリアへの侵達をブロック（水モード時は解除）
  float pu = texture(u_pigment, v_uv + vec2(0, px.y)).a;
  float pd = texture(u_pigment, v_uv - vec2(0, px.y)).a;
  float pl = texture(u_pigment, v_uv - vec2(px.x, 0)).a;
  float pr = texture(u_pigment, v_uv + vec2(px.x, 0)).a;
  const float DRY_WET = 0.05, MIN_PIG = 0.08;
  // u_dissolve_dry=1.0 の時：乾燥ロックなし→水が乾燥覆料エリアに浸進できる
  bool dryLock = u_dissolve_dry < 0.5;
  float effU = (dryLock && cu < DRY_WET && pu > MIN_PIG) ? c : cu;
  float effD = (dryLock && cd < DRY_WET && pd > MIN_PIG) ? c : cd;
  float effL = (dryLock && cl < DRY_WET && pl > MIN_PIG) ? c : cl;
  float effR = (dryLock && cr < DRY_WET && pr > MIN_PIG) ? c : cr;

  // ---- Resistor Network: 各ボンドに独立ノイズコンダクタンス ----
  // 3スケールノイズ: s0=超粗（ブロブ全体形状）, s1=中（繊維束）, s2=細（個別繊維）
  float s0 = 0.015, s1 = 0.05, s2 = 0.18;

  vec2 mU = (v_uv + vec2(0,    px.y*0.5)) * u_resolution;
  vec2 mD = (v_uv + vec2(0,   -px.y*0.5)) * u_resolution;
  vec2 mL = (v_uv + vec2(-px.x*0.5, 0))  * u_resolution;
  vec2 mR = (v_uv + vec2( px.x*0.5, 0))  * u_resolution;

  // s0(45%): 大きなランダム塊＝ブロブの全体形状を非対称に
  // s1(35%): 中スケール繊維バンドル
  // s2(20%): 細かい個別繊維
  float cU = fbm(mU*s0+u_seed*0.7)*0.45 + fbm(mU*s1+u_seed)*0.35 + h2(mU*s2+u_seed)*0.20;
  float cD = fbm(mD*s0+u_seed*0.7)*0.45 + fbm(mD*s1+u_seed)*0.35 + h2(mD*s2+u_seed)*0.20;
  float cL = fbm(mL*s0+u_seed*0.7)*0.45 + fbm(mL*s1+u_seed)*0.35 + h2(mL*s2+u_seed)*0.20;
  float cR = fbm(mR*s0+u_seed*0.7)*0.45 + fbm(mR*s1+u_seed)*0.35 + h2(mR*s2+u_seed)*0.20;
  // cX in [0..1]

  // amp増大(7.5→12.0) + base封鎖強化(0.92→0.97) = コンダクタンス比が最大150:1
  float rStr = clamp(u_paper_roughness * 0.55, 0.0, 1.0);
  float base = 1.0 - rStr * 0.97;   // 1.0 -> 0.03
  float amp  = rStr * 12.0;         // 0.0 -> 12.0

  float fU = clamp(base + cU * amp, 0.0, 8.0);
  float fD = clamp(base + cD * amp, 0.0, 8.0);
  float fL = clamp(base + cL * amp, 0.0, 8.0);
  float fR = clamp(base + cR * amp, 0.0, 8.0);

  // コンダクタンス重み付き Laplacian
  float sumF = fU + fD + fL + fR;
  float lap = effU*fU + effD*fD + effL*fL + effR*fR - c * sumF;

  // ---- 毛細管現象モデル: 水分が多いほど浸透圧が低下し、乾燥エリアで吸い込まれるように ----
  // 非線形な圧力勾配: w^2.0 などを使って「溜まり」や「鋭い滲み」を表現
  float press = pow(c, 0.45); // 0.45で「少量の水でもグッと吸い込まれる」ように
  float w = c + u_spread * lap * u_dt * (1.1 - press);

  // ---- 疏水性ドレイン (和紙のサイジング層) ----
  float localCond = (cU + cD + cL + cR) * 0.25;
  // しきい値を 0.30→0.35 に拡大 (より広い面積が水を弾く)
  float hydrophobicDrain = clamp((0.35 - localCond) / 0.35, 0.0, 1.0) * rStr;
  w *= (1.0 - hydrophobicDrain * 0.60 * u_dt * 30.0);

  w *= (1.0 - u_evaporation * u_dt);
  out_col = vec4(clamp(w, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

// ============================================================
//  PIGMENT – diffusion (湿潤セル間のみ)
// ============================================================
export const PIG_DIFFUSE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform float u_spread;
uniform float u_dt;
uniform float u_water_boost;  // 1.0=通常, 6.0=水モード時(顔料高送行)
uniform vec2  u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec2 px = 1.0 / u_resolution;
  float wc = texture(u_wetness, v_uv).r;
  // 通常時: 0.015 (乾くと顔料は定着して動かない)
  // 水モード時: 0.015 × 6 = 0.09 (バックラン効果のため高速拡散)
  float moveFactor = u_spread * 0.015 * u_dt * smoothstep(0.02, 0.18, wc) * u_water_boost;
  vec4 c = texture(u_pigment, v_uv);
  if (moveFactor < 0.0001) { out_col = c; return; }

  float wu = texture(u_wetness, v_uv + vec2(0,  px.y)).r;
  float wd = texture(u_wetness, v_uv - vec2(0,  px.y)).r;
  float wl = texture(u_wetness, v_uv - vec2(px.x, 0)).r;
  float wr = texture(u_wetness, v_uv + vec2(px.x, 0)).r;
  // 間値を下げて薄く濃れた隣接セルへも顔料が流れるように
  const float WET_THRESHOLD = 0.02;
  vec4 pu = (wu > WET_THRESHOLD) ? texture(u_pigment, v_uv + vec2(0,  px.y)) : c;
  vec4 pd = (wd > WET_THRESHOLD) ? texture(u_pigment, v_uv - vec2(0,  px.y)) : c;
  vec4 pl = (wl > WET_THRESHOLD) ? texture(u_pigment, v_uv - vec2(px.x, 0)) : c;
  vec4 pr = (wr > WET_THRESHOLD) ? texture(u_pigment, v_uv + vec2(px.x, 0)) : c;

  float lapA = pu.a + pd.a + pl.a + pr.a - 4.0 * c.a;
  float newA = c.a + lapA * moveFactor;
  
  // 色の混合：各成分ごとに拡散
  vec3 lapRGB = pu.rgb + pd.rgb + pl.rgb + pr.rgb - 4.0 * c.rgb;
  vec3 newRGB = c.rgb + lapRGB * moveFactor;

  // 密度の絶対保存 (浮動小数点誤差による消失をリセット)
  // 合計密度が変化しないように re-normalization (近似)
  float totalIn = pu.a + pd.a + pl.a + pr.a + c.a;
  newA = clamp(newA, 0.0, 1.0);
  
  // newRGB が 1.0 を超えた場合は Alpha に合わせて正規化し色飛びを防ぐ
  if (newA > 0.0001) {
      newRGB = clamp(newRGB, vec3(0.0), vec3(newA));
  } else {
      newRGB = vec3(0.0);
  }
  
  out_col = vec4(newRGB, newA);
}
`

// ============================================================
//  PIGMENT – FIXING (定着パス：乾燥した場所の顔料を背景レイヤーに「焼き付ける」)
// ============================================================
export const PIG_FIX_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;       // 現在拡散中のレイヤー
uniform sampler2D u_fixed_pigment; // 背景の定着レイヤー
uniform float u_dt;
uniform vec2  u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 pig = texture(u_pigment, v_uv);
  vec4 fixedPig = texture(u_fixed_pigment, v_uv);

  // 湿り気が閾値以下なら、積極的に定着レイヤーへ移行させる
  // 0.04 (DRY_WET) 以下のエリアで定着を開始
  float fixRate = smoothstep(0.08, 0.02, w); 
  
  // 拡散レイヤーから差し引く分
  float amountToFix = pig.a * fixRate;
  
  // 定着レイヤーとのカラーブレンド (Simple Additive Blend for density/premultiplied)
  vec4 newlyFixed = vec4(pig.rgb * fixRate, amountToFix);
  
  // 合計密度が1.0を超えないようにクランプしつつ加算
  vec4 res = fixedPig + newlyFixed;
  if(res.a > 1.0) {
      res.rgb *= (1.0 / res.a);
      res.a = 1.0;
  }
  
  out_col = res;
}
`;

// ============================================================
//  WETNESS – interaction
// ============================================================
export const WET_INTERACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform vec2  u_mouse;
uniform float u_radius;
uniform float u_water;
uniform float u_force;
uniform vec2  u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec2 px = v_uv * u_resolution;
  float d = distance(px, u_mouse);
  float nd = d / max(u_radius, 0.001);
  float f = clamp(1.0 - nd * nd, 0.0, 1.0);
  float prev = texture(u_wetness, v_uv).r;
  out_col = vec4(clamp(prev + u_water * f * u_force, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

// ============================================================
//  PIGMENT – interaction (色空間ブレンド方式)
// ============================================================
export const PIG_INTERACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_pigment;
uniform vec2  u_mouse;
uniform float u_radius;
uniform vec3  u_color;
uniform float u_density;
uniform float u_force;
uniform vec2  u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  vec2 px = v_uv * u_resolution;
  float d = distance(px, u_mouse);
  float nd = d / max(u_radius, 0.001);
  float f = clamp(1.0 - smoothstep(0.8, 1.0, nd), 0.0, 1.0);
  float strokeAdd = u_density * f * u_force;

  vec4 prev = texture(u_pigment, v_uv);
  float prevDensity = prev.a;
  vec3 prevColor = (prevDensity > 0.001) ? (prev.rgb / prevDensity) : u_color;
  float totalWeight = prevDensity + strokeAdd + 0.0001;
  float newWeight   = strokeAdd / totalWeight;
  vec3  blendColor  = mix(prevColor, u_color, clamp(newWeight, 0.0, 1.0));
  float newDensity  = clamp(prevDensity + strokeAdd, 0.0, 1.0);
  out_col = vec4(blendColor * newDensity, newDensity);
}
`;

// ============================================================
//  RENDER – 和紙テクスチャ + 水彩効果
// ============================================================
export const RENDER_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
uniform sampler2D u_fixed_pigment; // 定着顔料レイヤー
uniform float u_granulation;
uniform float u_edge_darkening;
uniform float u_paper_roughness;
uniform float u_seed;
uniform vec2  u_resolution;

float hash2(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash2(i),hash2(i+vec2(1,0)),f.x),
             mix(hash2(i+vec2(0,1)),hash2(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p) {
  float v=0.0; float a=0.5;
  for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.1+vec2(1.7,9.2);a*=0.5;}
  return v;
}
in vec2 v_uv; out vec4 out_color;

void main() {
  vec2 px = 1.0 / u_resolution;
  vec2 pixPos = v_uv * u_resolution;

  float wetness = texture(u_wetness, v_uv).r;
  vec4  activePig = texture(u_pigment, v_uv);
  vec4  fixedPig  = texture(u_fixed_pigment, v_uv);
  
  // 合成顔料 (固定レイヤーの上に現在のレイヤーを重ねる)
  // 背景 + (1 - 背景A) * 前景
  // 極小密度 (0.0005以下) によるジッターを抑制
  float fixedA  = (fixedPig.a > 0.0005) ? fixedPig.a : 0.0;
  float activeA = (activePig.a > 0.0005) ? activePig.a : 0.0;
  
  vec4 pig;
  pig.a   = clamp(fixedA + activeA, 0.0, 1.0);
  pig.rgb = fixedPig.rgb + activePig.rgb;
  
  float density = pig.a;
  vec3  pigColor = (density > 0.001) ? clamp(pig.rgb / density, 0.0, 1.0) : vec3(0.5);

  // ---- 和紙繊維テクスチャ (WET_DIFFUSEと同じ座標系) ----
  vec2 warp = vec2(
    fbm(pixPos * 0.018 + vec2(u_seed * 0.1, 0.0)),
    fbm(pixPos * 0.018 + vec2(0.0, u_seed * 0.1 + 4.3))
  ) * 6.0;
  float fiber1 = fbm((pixPos + warp) * 0.055 + u_seed);
  float fiber2 = fbm((pixPos + warp * 0.4) * 0.14 + u_seed + 9.1);
  float fiberVal = fiber1 * 0.6 + fiber2 * 0.4;  // 0..1

  // Bondノイズの平均でローカルコンダクタンスを再構築（疏水性ボイドの位置情報）
  float s1 = 0.05, s2 = 0.18;
  float condAvg = (
    fbm(pixPos*s1 + u_seed)*0.55 + hash2(pixPos*s2 + u_seed)*0.3 + hash2(pixPos*0.5 + u_seed+8.0)*0.15
  );

  // ---- 和紙ベースカラー ----
  float fiberStr = u_paper_roughness * 0.12;
  vec3 paperBase  = vec3(0.970, 0.960, 0.940);
  vec3 paperFiber = vec3(0.910, 0.895, 0.872);
  vec3 paperColor = mix(paperBase, paperFiber, (1.0 - fiberVal) * fiberStr * 8.0);

  // ---- グラニュレーション：顔料が繊維の谷に集積する ----
  float granStr = u_granulation * u_paper_roughness * 0.35;
  float originalDensity = density;
  float granMask = smoothstep(0.02, 0.20, originalDensity);
  // 振れ幅を 3.5→1.0 に縮小 (大きすぎる穴を防ぐ)
  float fiberGrain = (fiberVal - 0.45) * granStr * 1.0 * granMask;
  float fineGrain  = (noise(pixPos * 0.08 + u_seed + 22.0) - 0.5) * u_granulation * 0.25 * granMask;
  density = clamp(density + fiberGrain + fineGrain, 0.0, 1.3);

  // ---- 疏水性ボイド（しきい値を下げて穴の数を激減）----
  float rStr2    = clamp(u_paper_roughness * 0.55, 0.0, 1.0);
  // 0.30 → 0.12 : 極端に低いコンダクタンスの箇所のみ穴にする
  float voidMask = clamp((0.12 - condAvg) / 0.12, 0.0, 1.0) * rStr2;
  density = mix(density, density * 0.15, voidMask * 0.50);

  // ---- エッジ暗色化 ----
  float wGradX = texture(u_wetness, v_uv + vec2(px.x,0)).r - texture(u_wetness, v_uv - vec2(px.x,0)).r;
  float wGradY = texture(u_wetness, v_uv + vec2(0,px.y)).r - texture(u_wetness, v_uv - vec2(0,px.y)).r;
  float gradMag = sqrt(wGradX*wGradX + wGradY*wGradY);
  float edgeMask = gradMag * clamp(wetness * 8.0, 0.0, 1.0);
  float edgeBoost = edgeMask * u_edge_darkening * clamp(density * 2.5, 0.0, 1.0);
  density = clamp(density + edgeBoost, 0.0, 1.3);

  // エッジをふわっと: smoothstep (0.04,0.18)→(0.005,0.35) で広い柔らかいグラデーション
  float alpha = smoothstep(0.005, 0.35, density);

  // インクをわずかに半透明に → 紙の質感が透けて水彩らしくなる
  alpha *= 0.88;

  // ---- 最終色 ----
  float wetTint = clamp(wetness * 0.25, 0.0, 0.18);
  vec3 wetPaper  = mix(paperColor, paperColor * vec3(0.86, 0.89, 0.91), wetTint);
  vec3 inkOnPaper = pigColor * mix(vec3(1.0), paperColor * 1.1, 0.25);
  vec3 finalColor = mix(wetPaper, inkOnPaper, alpha);

  out_color = vec4(finalColor, 1.0);
}
`;

// ============================================================
//  PIGMENT – SUBTRACTION (定着した分を拡散レイヤーから消す)
// ============================================================
export const PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 pig = texture(u_pigment, v_uv);
  
  // WET_DIFFUSE と同じ閾値で減衰させる
  float fixRate = smoothstep(0.08, 0.02, w); 
  out_col = pig * (1.0 - fixRate);
}
`;

// ============================================================
//  PIGMENT – DISSOLVE (溶解パス：多量の水で背景レイヤーを抽出)
// ============================================================
export const PIG_DISSOLVE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_pigment;       // 現在拡散中のレイヤー
uniform sampler2D u_fixed_pigment; // 背景の定着レイヤー
uniform float u_dt;
uniform vec2  u_resolution;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 activePig = texture(u_pigment, v_uv);
  vec4 fixedPig  = texture(u_fixed_pigment, v_uv);

  // 溶解しきい値のハードガード: 0.70 未満では計算誤差を許さず 0.0 に固定
  float dissolveRate = 0.0;
  if (w >= 0.70) {
      dissolveRate = smoothstep(0.70, 0.95, w) * 0.02;
  }
  
  // 背景から active へ追加する分
  float amountToDissolve = fixedPig.a * dissolveRate;
  vec4 newlyActive = vec4(fixedPig.rgb * dissolveRate, amountToDissolve);
  
  out_col = activePig + newlyActive;
}
`;

// ============================================================
//  PIGMENT – FIXED_SUBTRACT (背景から溶解した分を消す)
// ============================================================
export const FIXED_PIG_SUBTRACT_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_wetness;
uniform sampler2D u_fixed_pigment;
in vec2 v_uv; out vec4 out_col;
void main() {
  float w = texture(u_wetness, v_uv).r;
  vec4 fixedPig = texture(u_fixed_pigment, v_uv);
  
  float dissolveRate = 0.0;
  if (w >= 0.70) {
      dissolveRate = smoothstep(0.70, 0.95, w) * 0.02;
  }
  out_col = fixedPig * (1.0 - dissolveRate);
}
`;
