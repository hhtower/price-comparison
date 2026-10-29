import React, { lazy, Suspense, useEffect, useState } from 'react';
import PublicPage from './PublicPage.jsx';
import PurchaseGuidePage from './PurchaseGuidePage.jsx';
import QualityToolsPage from './QualityToolsPage.jsx';
import OfficialReference from './OfficialReference.jsx';
import { logoUrl } from './Brand.jsx';
import { updatePageMetadata } from './page-metadata.js';
import './styles.css';
import './public-catalog.css';
import './quality-tools.css';
import './seo-document.css';
import './purchase-guide.css';

const AdminPage = lazy(() => import('./AdminPage.jsx'));

class AdminRouteBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return <main className="route-state" role="alert"><h1>管理端加载失败</h1><p>请重新加载页面后再试。</p><a href="/admin">重新加载管理端</a><a href="/">返回公开比价页</a></main>;
    return this.props.children;
  }
}

function currentRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/guide') return 'guide';
  if (pathname === '/admin') return 'admin';
  if (pathname === '/tools' || pathname.startsWith('/tools/')) return 'tools';
  if (pathname.startsWith('/products/')) return pathname;
  return 'public';
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  useEffect(() => {
    document.body.className = route === 'admin' ? 'admin-shell' : route === 'tools' ? 'tools-shell' : route === 'guide' ? 'guide-shell' : 'public-shell';
    if (!route.startsWith('/products/')) updatePageMetadata(route);
    let favicon = document.querySelector('link[rel="icon"]');
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.appendChild(favicon);
    }
    favicon.setAttribute('href', logoUrl);
  }, [route]);
  if (route === 'admin') return <AdminRouteBoundary><Suspense fallback={<main className="route-state" role="status">正在加载管理端…</main>}><AdminPage /></Suspense></AdminRouteBoundary>;
  if (route === 'guide') return <PurchaseGuidePage />;
  if (route === 'tools') return <><QualityToolsPage /><OfficialReference /></>;
  return <><PublicPage productId={route.startsWith('/products/') ? route.slice('/products/'.length) : undefined} /><OfficialReference /></>;
}
