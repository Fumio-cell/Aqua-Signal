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

        // Get initial user
        client.auth.getUser().then(({ data: { user: foundUser } }: any) => {
            setUser(foundUser);
            // Always set Pro for development (check DB profile in production)
            const finalPro = true; 
            (window as any).__isPro = finalPro;
            setIsPro(finalPro);
            // Notify other components
            window.dispatchEvent(new CustomEvent('auth:status', { detail: { user: foundUser, isPro: finalPro } }));
        });

        // Watch for auth state changes
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
                {/* Poetic Signal brand */}
                <div className="toolkit-brand">
                    <svg className="brand-icon" width="28" height="28" viewBox="0 0 48 48" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 24 L20 16 L26 24 L20 32 Z"/>
                        <circle cx="20" cy="24" r="1.6" fill="rgba(255,255,255,0.75)" stroke="none"/>
                        <path d="M26 24 L34 24"/>
                        <circle cx="36" cy="24" r="2.4"/>
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
                    border-bottom: 1px solid #9E3D3F;
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
                    font-family: 'Fraunces', serif;
                    font-size: 18px;
                    font-weight: 500;
                    font-optical-sizing: auto;
                    letter-spacing: 0.01em;
                    color: rgba(255, 255, 255, 0.9);
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
                        <h3>Watercolor Physics Engine</h3>

                        <div>
                            <p>Aqua-Signal simulates the physics of watercolor ink diffusing through washi paper. Using a GPU-accelerated Resistor Network model, it generates authentic granulation, edge darkening, and backrun (bloom) effects. Export as standard PNG or transparent PNG for use in any design workflow.</p>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </header>
    );
};
