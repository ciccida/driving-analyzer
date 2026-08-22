import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Driving Analyzer G-Meter',
  description: 'スマホセンサー連動 荷重移動・ドライビング診断',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'G-Meter',
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
