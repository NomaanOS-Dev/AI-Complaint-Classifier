import type { Metadata } from "next";
import { PublicContactForm } from "../../../components/public-contact-form";

export const metadata: Metadata = { title: "Contact support — NomaanOS", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function ContactPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicContactForm token={token} />;
}
