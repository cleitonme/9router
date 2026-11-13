import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

async function checkKeyOwnership(keyId) {
  const cookieStore = await cookies();
  const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
  if (!session) return { allowed: false, error: "Unauthorized", status: 401 };

  const key = await getApiKeyById(keyId);
  if (!key) return { allowed: false, error: "Key not found", status: 404 };

  return { allowed: true, key, session };
}

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const auth = await checkKeyOwnership(id);
    if (!auth.allowed) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }
    return NextResponse.json({ key: auth.key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const auth = await checkKeyOwnership(id);
    if (!auth.allowed) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const { isActive, name } = body;

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (name !== undefined) updateData.name = name;

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const auth = await checkKeyOwnership(id);
    if (!auth.allowed) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
