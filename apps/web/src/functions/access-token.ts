import { getCloudBrowserClient } from "@/functions/cloud-client";

export async function getAccessToken(): Promise<string> {
  const cloudClient = getCloudBrowserClient();
  const { data } = await cloudClient.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) {
    throw new Error("Not authenticated");
  }
  return token;
}
