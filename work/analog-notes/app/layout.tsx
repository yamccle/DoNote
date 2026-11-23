import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: "Yam's ONE", description: '记录每一次阅读、排查与设计思考。模拟集成电路设计的个人知识工作台。' };
export default function RootLayout({children}: {children: React.ReactNode}) { return <html lang="zh-CN"><body>{children}</body></html>; }
