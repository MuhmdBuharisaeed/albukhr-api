"use strict";

/*
 * New additive module for src/dapp-service-v2-gateway.js.
 * It supports direct owner verification only. It deliberately does NOT
 * authorize project managers until a verified Pi-identity ↔ auth.users link exists.
 * The gateway must continue authenticating the Pi bearer token via pioneer().
 */
function mountDappProjectPathway({
  router,
  db,
  pioneer,
  fail,
  noStore,
  clean,
  obj,
  UUID,
  consent
}) {
  async function findAlbukhrUser(piUid) {
    const result = await db
      .from("users")
      .select("id")
      .eq("pi_uid", piUid)
      .eq("network", "mainnet")
      .limit(2);

    if (result.error) throw result.error;
    const rows = result.data || [];
    if (rows.length > 1) {
      throw Object.assign(Error("Ambiguous ALBUKHR identity mapping."), { status: 409 });
    }
    return rows[0] || null;
  }

  async function listOwnedProjects(piUid, ownerUserId) {
    // The database eligibility RPC remains the canonical authorization gate.
    // Its current definition can classify a linked contributor as "owner" when
    // the contributor maps to projects.owner_user_id. The live request column
    // project_owner_albukhr_user_id must identify the actual ALBUKHR project
    // owner, so require a second, exact owner_albukhr_user_id match before
    // exposing a project or accepting a request. This deliberately permits
    // direct owners only and prevents writing the applicant as the owner of a
    // project they merely manage/represent.
    if (!UUID.test(String(ownerUserId || ""))) return [];

    const eligible = await db.rpc("dapp_service_get_eligible_projects", {
      p_pi_uid: piUid,
      p_network: "mainnet"
    });
    if (eligible.error) throw eligible.error;

    const eligibleIds = (eligible.data || [])
      .filter(row => row && row.relationship === "owner")
      .map(row => String(row.project_id || ""))
      .filter(id => UUID.test(id));

    if (!eligibleIds.length) return [];

    const verified = await db
      .from("projects")
      .select("id,project_code,slug,name,project_type,status,network,owner_albukhr_user_id")
      .eq("network", "mainnet")
      .eq("owner_albukhr_user_id", ownerUserId)
      .in("id", eligibleIds)
      .in("project_type", ["internal", "external"])
      .in("status", ["approved", "active"]);

    if (verified.error) throw verified.error;

    return (verified.data || [])
      .map(row => ({
        id: String(row.id || ""),
        project_code: clean(row.project_code, 100),
        slug: clean(row.slug, 100),
        name: clean(row.name, 120),
        project_type: row.project_type,
        status: row.status
      }))
      .filter(row => UUID.test(row.id) && row.name);
  }

  router.get("/projects/eligible", async (req, res) => {
    const piUser = await pioneer(req, res);
    if (!piUser) return;

    try {
      const profile = await findAlbukhrUser(piUser.uid);
      if (!profile) {
        noStore(res);
        return res.json({
          success: true,
          network: "mainnet",
          ownershipVerified: false,
          projects: []
        });
      }

      const projects = await listOwnedProjects(piUser.uid, profile.id);
      noStore(res);
      return res.json({
        success: true,
        network: "mainnet",
        ownershipVerified: true,
        projects
      });
    } catch (_) {
      return fail(res, 503, "Project ownership could not be verified. Please retry.");
    }
  });

  router.post("/requests/project", async (req, res) => {
    const piUser = await pioneer(req, res);
    if (!piUser) return;

    const body = obj(req.body);
    const projectId = clean(body.projectId, 50);
    const description = clean(body.description, 4000);

    if (
      body.consentAccepted !== true ||
      clean(body.consentVersion, 80) !== consent
    ) {
      return fail(res, 400, "Accept the current service terms.");
    }

    if (!UUID.test(projectId) || !description) {
      return fail(res, 400, "Choose a verified project and describe the app you need.");
    }

    try {
      const profile = await findAlbukhrUser(piUser.uid);
      if (!profile) {
        return fail(res, 403, "Your ALBUKHR account could not be linked to this verified Pi identity.");
      }

      // Revalidate through the canonical database eligibility function at submit time.
      // The browser contributes only projectId; project name and relationship are server-derived.
      let project;
      try {
        project = (await listOwnedProjects(piUser.uid, profile.id)).find(row => row.id === projectId) || null;
      } catch (_) {
        return fail(res, 503, "Project ownership could not be verified. Please retry.");
      }
      if (!project) {
        return fail(res, 403, "This project is not eligible or its direct ownership could not be verified.");
      }

      const saved = await db
        .from("dapp_service_requests")
        .insert({
          network: "mainnet",
          applicant_pi_uid: piUser.uid,
          pi_username: piUser.username || null,
          project_name: project.name,
          service_type: "albukhr_project",
          project_id: project.id,
          project_type: project.project_type,
          project_relationship: "owner",
          project_relationship_verified_at: new Date().toISOString(),
          project_owner_albukhr_user_id: profile.id,
          description,
          consent_version: consent,
          request_status: "submitted",
          payment_status: "unpaid"
        })
        .select("id,network,project_name,service_type,project_id,project_type,project_relationship,project_relationship_verified_at,request_status,payment_status,created_at")
        .single();

      if (saved.error) {
        return fail(res, 503, "Project app request could not be saved.");
      }

      noStore(res);
      return res.status(201).json({
        success: true,
        network: "mainnet",
        request: saved.data
      });
    } catch (_) {
      return fail(res, 503, "Project app request could not be saved. Please retry.");
    }
  });
}

module.exports = { mountDappProjectPathway };
