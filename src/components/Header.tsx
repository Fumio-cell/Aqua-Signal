import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase, signInWithGoogle, signOut } from '../lib/commercial';
import { LogIn, LogOut, Zap, Info, X } from 'lucide-react';

export const Header: React.FC = () => {
    const [user, setUser] = useState<any>(null);
    const [isPro, setIsPro] = useState(false);
    const [showInfo, setShowInfo] = useState(false);

    useEffect(() => {
        const client = supabase;
        if (!client) return;

        // 初期ユーザー取得
        client.auth.getUser().then(({ data: { user: foundUser } }: any) => {
            setUser(foundUser);
            // 開発中は便宜上常にProとする（本番ではDBプロフィールを参照）
            const finalPro = true; 
            (window as any).__isPro = finalPro;
            setIsPro(finalPro);
            // 他のコンポーネントへ通知
            window.dispatchEvent(new CustomEvent('auth:status', { detail: { user: foundUser, isPro: finalPro } }));
        });

        // 状態変更を監視
        const { data: authListener } = client.auth.onAuthStateChange(async (_event: any, session: any) => {
            const currentUser = session?.user ?? null;
            setUser(currentUser);
            const finalPro = true;
            (window as any).__isPro = finalPro;
            setIsPro(finalPro);
            window.dispatchEvent(new CustomEvent('auth:status', { detail: { user: currentUser, isPro: finalPro } }));
        });

        return () => {
            authListener?.subscription.unsubscribe();
        };
    }, []);

    const login = () => signInWithGoogle();
    const logout = () => signOut();

    return (
        <header className="toolkit-header">
            <div className="header-left">
                {/* Poetic Signal ブランド */}
                <div className="toolkit-brand">
                    <svg className="brand-icon" viewBox="0 0 48 48" fill="none">
                        <ellipse cx="24" cy="26" rx="17" ry="14" stroke="#5ce0fc" strokeWidth="1" opacity="0.3" strokeDasharray="2 3"/>
                        <ellipse cx="24" cy="25" rx="11" ry="9" stroke="#5ce0fc" strokeWidth="1.2" opacity="0.55"/>
                        <ellipse cx="24" cy="25" rx="6" ry="5" stroke="#7c5cfc" strokeWidth="1.5" opacity="0.8"/>
                        <circle cx="24" cy="25" r="3" fill="#5ce0fc" opacity="0.9"/>
                        <path d="M24 8 Q25.5 14 24 19" stroke="#5ce0fc" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
                        <circle cx="24" cy="7" r="2" fill="#7c5cfc" opacity="0.8"/>
                        <path d="M13 23 Q11 20 10 18" stroke="#5ce0fc" strokeWidth="1" strokeLinecap="round" opacity="0.5"/>
                        <path d="M35 23 Q37 20 38 18" stroke="#5ce0fc" strokeWidth="1" strokeLinecap="round" opacity="0.5"/>
                        <path d="M18 34 Q16 37 15 39" stroke="#5ce0fc" strokeWidth="1" strokeLinecap="round" opacity="0.4"/>
                        <path d="M30 34 Q32 37 33 40" stroke="#5ce0fc" strokeWidth="1" strokeLinecap="round" opacity="0.4"/>
                    </svg>
                    <span className="toolkit-name">Poetic Signal Toolkit</span>
                </div>
                <div className="app-separator">/</div>
                <div className="app-name">Aqua-Signal</div>
                <button onClick={() => setShowInfo(true)} className="info-btn">
                    <Info className="w-4 h-4" />
                </button>
            </div>

            <div className="header-right">
                {user ? (
                    <div className="user-profile">
                        <div className={`pro-badge ${isPro ? 'active' : ''}`}>
                            <Zap className="w-3 h-3" />
                            PRO
                        </div>
                        <span className="user-email">{user.email}</span>
                        <button onClick={logout} className="icon-btn" title="Logout">
                            <LogOut className="w-4 h-4" />
                        </button>
                    </div>
                ) : (
                    <div className="user-profile">
                        <div className="pro-badge active">
                            <Zap className="w-3 h-3" />
                            PRO
                        </div>
                        <span className="user-email">Local Mode</span>
                        <button onClick={login} className="icon-btn" title="Login for Sync">
                            <LogIn className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>

            <style>{`
                .toolkit-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 0.75rem 1.5rem;
                    background: rgba(15, 23, 42, 0.85);
                    backdrop-filter: blur(12px);
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    position: sticky;
                    top: 0;
                    z-index: 1000;
                    font-family: 'Inter', system-ui, -apple-system, sans-serif;
                    font-size: 0.875rem;
                    flex-shrink: 0;
                    height: 56px;
                    box-sizing: border-box;
                }
                .header-left, .header-right {
                    display: flex;
                    align-items: center;
                    gap: 1rem;
                }
                .toolkit-brand {
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    color: #7c5cfc;
                }
                .brand-icon {
                    width: 32px;
                    height: 32px;
                }
                .toolkit-name {
                    font-size: 20px;
                    font-weight: 800;
                    letter-spacing: -0.02em;
                    color: #fff;
                }
                .app-separator {
                    color: rgba(255, 255, 255, 0.2);
                    font-weight: 300;
                    margin: 0 0.5rem;
                    font-size: 20px;
                }
                .app-name {
                    color: rgba(255, 255, 255, 0.85);
                    font-size: 20px;
                    font-weight: 600;
                    letter-spacing: -0.01em;
                }
                .user-profile {
                    display: flex;
                    align-items: center;
                    gap: 0.75rem;
                    background: rgba(255, 255, 255, 0.06);
                    padding: 0.35rem 0.5rem 0.35rem 0.75rem;
                    border-radius: 9999px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .pro-badge {
                    display: flex;
                    align-items: center;
                    gap: 0.25rem;
                    font-size: 0.7rem;
                    font-weight: 800;
                    padding: 0.2rem 0.5rem;
                    border-radius: 9999px;
                    background: rgba(255, 255, 255, 0.1);
                    color: #94a3b8;
                    letter-spacing: 0.05em;
                }
                .pro-badge.active {
                    background: #f59e0b;
                    color: #fff;
                    box-shadow: 0 0 10px rgba(245, 158, 11, 0.3);
                }
                .user-email {
                    font-size: 0.85rem;
                    color: rgba(255, 255, 255, 0.9);
                    font-weight: 500;
                    letter-spacing: 0.01em;
                }
                .icon-btn {
                    background: none;
                    border: none;
                    color: rgba(255, 255, 255, 0.5);
                    cursor: pointer;
                    padding: 0.4rem;
                    display: flex;
                    align-items: center;
                    border-radius: 50%;
                    transition: all 0.2s ease;
                }
                .icon-btn:hover {
                    color: #fff;
                    background: rgba(255, 255, 255, 0.1);
                }
           
                .info-modal-overlay {
                    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
                    display: flex; align-items: center; justify-content: center; z-index: 99999;
                }
                .info-modal {
                    background: #111827; border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 16px; padding: 32px; max-width: 600px;
                    width: 90%; max-height: 85vh; overflow-y: auto;
                    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
                    position: relative;
                    text-align: left;
                }
                .info-modal h2 { margin-top: 0; color: #f8fafc; font-size: 1.5rem; }
                .info-modal h3 { color: #7c5cfc; font-size: 0.85rem; margin-bottom: 24px; font-weight: 600; }
                .info-modal p { color: #cbd5e1; line-height: 1.6; font-size: 0.9rem; margin-bottom: 12px; }
                .info-close {
                    position: absolute; top: 16px; right: 16px;
                    background: transparent; border: none; color: #64748b;
                    cursor: pointer; padding: 6px; border-radius: 6px; transition: all 0.2s;
                }
                .info-close:hover { color: #f8fafc; background: rgba(255,255,255,0.1); }
                .info-btn {
                    background: transparent; border: none; color: #64748b; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    margin-left: 12px; transition: color 0.2s;
                }
                .info-btn:hover { color: #f8fafc; }
            `}</style>
        
            {showInfo && createPortal(
                <div className="info-modal-overlay" onClick={() => setShowInfo(false)}>
                    <div className="info-modal" onClick={e => e.stopPropagation()}>
                        <button className="info-close" onClick={() => setShowInfo(false)}><X className="w-5 h-5"/></button>
                        <h2>Aqua-Signal</h2>
                        <h3>Watercolor Physics Engine | 水彩物理シミュレーション・エンジン</h3>

                        <div style={{ marginBottom: '20px' }}>
                            <div style={{ display: 'inline-block', background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', marginBottom: '8px' }}>EN</div>
                            <p>Aqua-Signal simulates the physics of watercolor ink diffusing through washi paper. Using a GPU-accelerated Resistor Network model, it generates authentic granulation, edge darkening, and backrun (bloom) effects. Export as standard PNG or transparent PNG for use in any design workflow.</p>
                        </div>

                        <div>
                            <div style={{ display: 'inline-block', background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', marginBottom: '8px' }}>JP</div>
                            <p>Aqua-Signalは、和紙に水彩インクが浸透する物理現象をGPU上でリアルタイムシミュレーションするツールです。不均一な拡散、顔料の粒状感、エッジの暗色化を再現。透過PNGエクスポートに対応。</p>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </header>
    );
};
