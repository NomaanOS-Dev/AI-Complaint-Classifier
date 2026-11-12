import type { Metadata } from "next";
import { DocsViewer } from "../../components/docs-viewer";

export const metadata: Metadata = {
  title: "User Guide — NomaanOS",
  description: "Customer-facing User Guide for NomaanOS — learn how to create workspaces, manage complaints, review AI insights, view analytics, and set up complaint forms."
};

export default function DocsPage() {
  return <DocsViewer />;
}
