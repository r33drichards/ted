import type { Metadata } from 'next';
import '@cloudscape-design/global-styles/index.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ted',
  description: 'Durable Claude chat',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
