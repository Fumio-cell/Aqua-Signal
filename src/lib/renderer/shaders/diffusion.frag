#version 300 es
precision highp float;

uniform sampler2D u_wetness_map;
uniform float u_spread;
uniform float u_evaporation;
uniform float u_delta_time;
uniform vec2 u_resolution;

in vec2 v_uv;
out vec4 out_color;

void main() {
  vec2 texel = 1.0 / u_resolution;
  
  float center = texture(u_wetness_map, v_uv).r;
  float up = texture(u_wetness_map, v_uv + vec2(0.0, texel.y)).r;
  float down = texture(u_wetness_map, v_uv - vec2(0.0, texel.y)).r;
  float left = texture(u_wetness_map, v_uv - vec2(texel.x, 0.0)).r;
  float right = texture(u_wetness_map, v_uv + vec2(texel.x, 0.0)).r;

  // Discrete Laplacian
  float laplacian = (up + down + left + right) - 4.0 * center;
  
  // Diffusion eq: dW/dt = D * laplacian
  float next_wetness = center + u_spread * laplacian * u_delta_time;
  
  // Evaporation
  next_wetness *= (1.0 - u_evaporation * u_delta_time);
  
  // Clamp to positive
  next_wetness = max(0.0, next_wetness);

  out_color = vec4(next_wetness, 0.0, 0.0, 1.0);
}
