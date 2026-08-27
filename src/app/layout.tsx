import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'G-Smooth Driving Lab | 荷重移動・ドライビング診断',
  description: 'スマホセンサー連動で荷重移動・摩擦円トレース率を診断。運転のスムーズさをAIが自動採点する無料Webアプリ。',
  manifest: '/manifest.json',
  openGraph: {
    title: 'G-Smooth Driving Lab | 荷重移動・ドライビング診断',
    description: 'スマホのGセンサーを使って、あなたの運転スムーズさを採点・AI診断します！',
    url: 'https://driving-analyzer.vercel.app',
    siteName: 'G-Smooth Driving Lab',
    locale: 'ja_JP',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'G-Smooth Driving Lab',
    description: 'スマホのGセンサーを使って、あなたの運転スムーズさを採点・AI診断します！',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'G-Smooth',
  },
};

export const viewport = {
  themeColor: '#000000',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="bg-black text-white antialiased">
        {children}
      </body>
    </html>
  );
}
