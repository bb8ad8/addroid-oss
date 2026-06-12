import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma";
import { requireTrustedJsonWebAction } from "../../../lib/request-guard";
import { ensureWebWorkspace } from "../../../lib/github-runtime";
import {
  createExperimentRegistration,
  ExperimentRegistrationError,
} from "../../../../worker/src/lib/experiment-registration";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireTrustedJsonWebAction(request);
  if (denied) return denied;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  try {
    const workspace = await ensureWebWorkspace();
    const experiment = await createExperimentRegistration({
      prisma,
      workspaceId: workspace.id,
      input: isRecord(payload) ? payload : {},
      actor: "user:web-ui",
    });
    return NextResponse.json({ ok: true, experiment });
  } catch (err) {
    const registrationError = experimentRegistrationErrorToResponse(err);
    if (registrationError) return registrationError;
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

export function experimentRegistrationErrorToResponse(err: unknown): NextResponse | null {
  if (!(err instanceof ExperimentRegistrationError)) return null;
  return NextResponse.json(
    { ok: false, error: err.message },
    { status: err.statusCode },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
