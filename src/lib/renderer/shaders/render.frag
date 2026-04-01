#version 300 es
precision highp float;

uniform sampler2D u_pigment_map;
uniform sampler2D u_wetness_map;
uniform float u_granulation;
uniform float u_edge_darkening;
uniform float u_paper_roughness;
uniform float u_seed;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 out_color;

// Simple hash for noise
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec4 pigment = texture(u_pigment_map, v_uv);
  float wetness = texture(u_wetness_map, v_uv).r;
  
  // 1. Edge Darkening
  // Pigment accumulates at the boundary where water is drying
  // We can approximate this by the gradient of wetness or simple thresholding
  // But more physically, it's where wetness is low but not zero
  float edge = smoothstep(0.05, 0.0, abs(wetness - 0.02)) * u_edge_darkening;
  
  // 2. Granulation
  // Random noise affecting density
  float noise = hash(v_uv * u_resolution + u_seed);
  float gran = (noise - 0.5) * u_granulation * pigment.a;
  
  // 3. Paper Texture
  // Dynamic noise for paper
  float paper = (hash(v_uv * u_resolution * 0.5 + u_seed + 1.0) - 0.5) * u_paper_roughness;
  
  vec3 color = pigment.rgb;
  float alpha = clamp(pigment.a + gran + edge, 0.0, 1.0);
  
  // Background white paper
  vec3 bg = vec3(1.0 + paper);
  
  // Simple alpha blending
  vec3 final_rgb = mix(bg, color, alpha);
  
  out_color = vec4(final_rgb, 1.0);
}
