import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Navigation } from "@/components/Navigation";
import { Footer } from "@/components/Footer";
import { SyncAllSourcesProvider } from "@/components/SyncAllSources";
import { AuthGate } from "@/components/AuthGate";
import { isAuthDisabled } from "@/lib/auth/guard";

// 服务端判定认证开关并下发给客户端 gate：WR_AUTH_DISABLED=1 时整套认证关闭
//（ADR-0020），客户端不应再把页面重定向到 /login。注意静态预渲染页面会在
// 构建期固化该值——这个开关是「构建与运行一起开/关」的测试/开发旋钮，
// 不存在构建开着、运行关着的组合。
const authEnabled = !isAuthDisabled();

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Weekly Reporter",
  description: "Personal weekly report manager",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <AuthGate authEnabled={authEnabled} />
        <ThemeProvider>
          <SyncAllSourcesProvider>
            <Navigation />
            <main className="flex-1">
              {children}
            </main>
          </SyncAllSourcesProvider>
          <Footer />
        </ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
