import { redirect } from "next/navigation";

export default async function NewProviderPage() {
  redirect("/settings");
}
