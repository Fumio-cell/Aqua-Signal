import React, { useState } from 'react';
import { useSimulation } from './hooks/useSimulation';
import { Snowflake, Play, RotateCcw, Download, Zap } from 'lucide-react';
import { Header } from './components/Header';
import { openLemonSqueezyCheckout } from './lib/commercial';

const PRESET_COLORS = [
  { name: 'Ink Blue',    hex: '#1a40d0', rgb: [0.10, 0.25, 0.82] },
  { name: 'Crimson',     hex: '#c0161e', rgb: [0.75, 0.09, 0.12] },
  { name: 'Forest',      hex: '#1a6b2e', rgb: [0.10, 0.42, 0.18] },
  { name: 'Violet',      hex: '#6b1ab0', rgb: [0.42, 0.10, 0.69] },
  { name: 'Amber',       hex: '#c06010', rgb: [0.75, 0.38, 0.06] },
  { name: 'Teal',        hex: '#0f8080', rgb: [0.06, 0.50, 0.50] },
];

const App: React.FC = () => {
  const width  = 1024;
  const height = 1024;
  const { canvasRef, engineRef, params, updateParams, undo, exportPNG, exportTransparentPNG } =
    useSimulation(width, height);

  const [colorHex, setColorHex] = useState('#1a40d0');
  const [user, setUser] = useState<any>(null);
  const [isPro, setIsPro] = useState(false);

  // 認証状態の監視
  React.useEffect(() => {
    const handleAuth = (e: any) => {
      setUser(e.detail.user);
      setIsPro(e.detail.isPro);
    };
    window.addEventListener('auth:status', handleAuth);
    // 初期状態の取得（Headerがマウント済みの場合）
    if ((window as any).__isPro !== undefined) {
      setIsPro((window as any).__isPro);
    }
    return () => window.removeEventListener('auth:status', handleAuth);
  }, []);

  // PRO 権限チェック
  const checkPro = (actionName: string) => {
    if (!isPro && user) {
      if (confirm(`${actionName} は PRO 限定機能です。ライセンスを購入しますか？`)) {
        openLemonSqueezyCheckout(user.id);
      }
      return false;
    }
    return true;
  };

  const canvasPos = (e: React.MouseEvent): [number, number] => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return [
      (e.clientX - r.left)  * (c.width  / r.width),
      (e.clientY - r.top)   * (c.height / r.height),
    ];
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    engineRef.current?.saveUndoState();
    updateParams({ isMouseDown: true, mousePos: canvasPos(e) });
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!params.isMouseDown) return;
    updateParams({ mousePos: canvasPos(e) });
  };
  const handleMouseUp = () => updateParams({ isMouseDown: false });

  const hexToRgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1,3),16)/255,
    parseInt(hex.slice(3,5),16)/255,
    parseInt(hex.slice(5,7),16)/255,
  ];

  const applyColor = (hex: string, rgb?: number[]) => {
    setColorHex(hex);
    const [r, g, b] = rgb ?? hexToRgb(hex);
    updateParams({ pigmentColor: [r, g, b, params.pigmentColor[3]] });
  };

  /* ── スライダーコンポーネント ── */
  const SliderRow = ({
    label, value, min, max, step, onChange, unit = '', large = false
  }: {
    label: string; value: number; min: number; max: number;
    step: number; onChange: (v: number) => void; unit?: string; large?: boolean;
  }) => (
    <div className={`slider-row ${large ? 'slider-row--large' : ''}`}>
      <div className="slider-label-row">
        <span className={`control-label ${large ? 'control-label--large' : ''}`}>{label}</span>
        <span className={`slider-value ${large ? 'slider-value--large' : ''}`}>
          {value.toFixed(step < 0.1 ? 3 : step < 1 ? 2 : 0)}{unit}
        </span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        className={large ? 'range--large' : ''}
        onChange={e => onChange(parseFloat(e.target.value))} />
    </div>
  );

  const isFrozen = !params.isPlaying;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header />
      <div className="main-container">
      {/* ============ LEFT – Color Panel ============ */}
      <aside className="left-panel">
        <div className="left-panel-header">Mode</div>

        {/* ---- Ink / Water モード切替 ---- */}
        <div className="mode-toggle">
          <button
            className={`mode-btn ${!params.waterOnly ? 'mode-btn--active' : ''}`}
            onClick={() => updateParams({ waterOnly: false })}
            title="インクを落とす"
          >🎨 Ink</button>
          <button
            className={`mode-btn mode-btn--water ${params.waterOnly ? 'mode-btn--active-water' : ''}`}
            onClick={() => updateParams({ waterOnly: true })}
            title="水だけを落とす（顔料が外側に押し出される）"
          >💧 Water</button>
        </div>

        <div className="left-panel-header" style={{marginTop: 8}}>Color</div>

        {/* Current color preview + picker button */}
        <div className="color-preview-wrap">
          <div className="color-preview" style={{ background: colorHex }} />
          <label className="custom-btn" title="カスタムカラーを選ぶ">
            <input
              type="color"
              value={colorHex}
              onChange={e => applyColor(e.target.value)}
              className="hidden-color-input"
            />
            <span>Custom</span>
          </label>
        </div>

        {/* Preset swatches */}
        <div className="swatches">
          {PRESET_COLORS.map(c => (
            <div
              key={c.name}
              className={`swatch ${colorHex === c.hex ? 'active' : ''}`}
              style={{ background: c.hex }}
              onClick={() => applyColor(c.hex, c.rgb)}
              title={c.name}
            />
          ))}
        </div>

        {/* Density */}
        <div className="knob-wrap">
          <span className="control-label">Density</span>
          <input type="range" min="0.1" max="2" step="0.05"
            value={params.pigmentColor[3]}
            onChange={e => {
              const d = parseFloat(e.target.value);
              updateParams({ pigmentColor: [
                params.pigmentColor[0],params.pigmentColor[1],params.pigmentColor[2],d
              ]});
            }} />
        </div>
      </aside>

      {/* ============ CANVAS ============ */}
      <main className="canvas-container"
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* ── トップバー: スライダー + 右端にRunボタン ── */}
        <div className="canvas-topbar">

          {/* ① Undo（左端・小） */}
          <button className="btn-icon" onClick={undo} title="Undo（1ストローク戻す）">
            <RotateCcw size={15} />
          </button>

          {/* ② スライダー群（均等に） */}
          <SliderRow label="Brush Size" value={params.brushSize}
            min={10} max={300} step={5} unit="px" large
            onChange={v => updateParams({ brushSize: v })} />
          <SliderRow label="Flow Speed" value={params.flowSpeed}
            min={0.1} max={100} step={0.1} large
            onChange={v => updateParams({ flowSpeed: v })} />
          <SliderRow label="Water" value={params.waterAmount}
            min={0.05} max={1} step={0.05} large
            onChange={v => updateParams({ waterAmount: v })} />

          {/* セパレーター */}
          <div className="topbar-sep" />

          {/* ③ RUN / FREEZE ボタン（右端・大・右利き最適） */}
          <button
            className={`btn-main-action ${isFrozen ? 'btn-main-action--run' : 'btn-main-action--freeze'}`}
            onClick={() => updateParams({ isPlaying: !params.isPlaying })}
            title={isFrozen ? 'Run – シミュレーション再開' : 'Freeze – 現在の状態を固定'}
          >
            {isFrozen
              ? <><Play size={15}/> Run</>
              : <><Snowflake size={15}/> Freeze</>}
          </button>
        </div>

        <canvas
          ref={canvasRef}
          width={width} height={height}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          style={{ maxHeight: '82vh', maxWidth: '72vw', display: 'block',
            boxShadow: '0 8px 60px rgba(0,0,0,0.5)' }}
        />
      </main>

      {/* ============ RIGHT – Control Panel ============ */}
      <aside className="right-panel">

        {/* --- Drop --- */}
        <div className="panel-section">
          <div className="panel-header">Liquid Drop</div>
          <SliderRow label="Pigment Density" value={params.pigmentColor[3]}
            min={0.1} max={2} step={0.05}
            onChange={v => updateParams({ pigmentColor:
              [params.pigmentColor[0],params.pigmentColor[1],params.pigmentColor[2],v]
            })} />
        </div>

        {/* --- Behavior --- */}
        <div className="panel-section">
          <div className="panel-header">Liquid Behavior</div>
          <SliderRow label="Spread" value={params.spread}
            min={0} max={1.0} step={0.01}
            onChange={v => updateParams({ spread: v })} />
          <SliderRow label="Evaporation" value={params.evaporation}
            min={0} max={0.03} step={0.001}
            onChange={v => updateParams({ evaporation: v })} />
        </div>

        {/* --- Effects --- */}
        <div className="panel-section">
          <div className="panel-header">Effects</div>
          <SliderRow label="Granulation" value={params.granulation}
            min={0} max={1} step={0.05}
            onChange={v => updateParams({ granulation: v })} />
          <SliderRow label="Edge Darkening" value={params.edgeDarkening}
            min={0} max={2} step={0.05}
            onChange={v => updateParams({ edgeDarkening: v })} />
          <SliderRow label="Paper Texture" value={params.paperRoughness}
            min={0} max={2} step={0.1}
            onChange={v => updateParams({ paperRoughness: v })} />
        </div>

        {/* --- Render / Export --- */}
        <div className="panel-section">
          <div className="panel-header">Export</div>
          <button className="btn btn-export" onClick={() => exportPNG(1024)}>
            <Download size={14}/> PNG  1K (Free)
          </button>
          <button className="btn btn-export" onClick={() => checkPro('2K Export') && exportPNG(2048)}
            style={{ marginTop: 6, background: 'rgba(74,143,255,0.75)' }}>
            <Zap size={10} style={{marginRight: 4}}/> PNG  2K (PRO)
          </button>
          <button className="btn btn-secondary" onClick={() => checkPro('Transparent Export') && exportTransparentPNG(2048)}
            style={{ marginTop: 6 }}>
            <Zap size={10} style={{marginRight: 4}}/> 透過 PNG  2K (PRO)
          </button>
          <p className="seed-label">Seed: {params.seed.toFixed(0)}</p>
          <p className="seed-label" style={{fontSize: 9}}>
            Canvas: {params.width ?? 1024} × {params.height ?? 1024}px
          </p>
        </div>

      </aside>
    </div>
    </div>
  );
};

export default App;
