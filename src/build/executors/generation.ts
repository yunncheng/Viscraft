import { validateGenerationReferenceSet } from '../../backends/providers/extension.js';
/**
 * Provider-backed executor: `provider`.
 *
 * It authors a request against a runtime Endpoint binding and runs it through
 * the shared provider pipeline. Its reference resolution, ordered-reference
 * identity, provider identity (which scopes the implementation fingerprint to the
 * selected protocol/vendor), read-only request preflight and generation are
 * owned here. The provider protocol/model adapters stay in
 * `backends/providers/**`; this executor is the one place that knows a Source of
 * this kind exists.
 *
 * Image generation is NOT a Source kind: it is the standalone Runtime
 * operation `generate-image`, which produces an Asset (see
 * `operations/assets/generate-image.ts`).
 */
import { probeMedia } from '../../backends/media/probe.js';
import { generationExtensionIdentity } from '../../backends/providers/extension.js';
import { transmittedReferences, type VideoLaneResolution } from '../../backends/providers/lane.js';
import {
  packagedExtensionFor,
  packagedModelsForProtocol,
  requiresModelDefinition,
} from '../../backends/providers/models/registry.js';
import { referenceFacts, validateReferenceLocator } from '../../backends/providers/reference-facts.js';
import { inspectVideoApiAttempt } from '../../backends/providers/services/video-tasks.js';
import { inspectRunwayAttempt } from '../../backends/providers/services/runway/index.js';
import { inspectFalAttempt } from '../../backends/providers/services/fal/index.js';
import type { AttemptInspection } from '../../backends/providers/attempt.js';
import {
  generateVideoService,
  isVendorProtocol,
  prepareVideoRequest,
  resolveEffectiveExtension,
  resolveVideoLane,
  videoServiceProtocol,
} from '../../backends/providers/video-service.js';
import { credentialSetupHint } from '../../config/credentials.js';
import { userEndpointsFile } from '../../config/endpoints.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import type { Asset, ProviderSource } from '../../core/schema.js';
import { emptyResolved } from './shared.js';
import type { ExecutorIssue, ResolvedSource, SourceContext, SourceExecutor } from './types.js';

/** The `{asset,category,role}` references the provider executor resolves. */
function generationResolved(source: ProviderSource, context: SourceContext): ResolvedSource {
  const resolvedReferences = source.references.map(reference =>
    context.project.assets.find(a => a.id === reference.asset)!,
  );
  const generationReferences = source.references.map(reference => ({
    asset: reference.asset,
    category: reference.category,
    role: reference.role,
  }));
  return { ...emptyResolved(), resolvedReferences, generationReferences };
}

/** The read-only video-reference media check. */
async function referenceMediaIssues(
  context: SourceContext,
  source: ProviderSource,
  effective:
    { model: { validateReference?: (reference: never, media: never, audioCodecs: string[]) => void } } | undefined,
): Promise<ExecutorIssue[]> {
  const issues: ExecutorIssue[] = [];
  for (const reference of source.references) {
    if (reference.category !== 'video') continue;
    const asset = context.project.assets.find(candidate => candidate.id === reference.asset);
    if (!asset) continue;
    // Reading the file and judging the model's rules are TWO different facts. An
    // unreadable/missing/unprobeable file is not a model violation: it cannot be
    // transmitted at all, and reporting "the model refuses it" would hide the real
    // cause and make the obstacle look unfixable.
    let media: Awaited<ReturnType<typeof probeMedia>>;
    let audioCodecs: string[];
    try {
      const absolute = await resolveProjectPath(context.loadRoot, asset.path);
      media = await probeMedia(absolute);
      const metadata = JSON.parse(
        await runCommand('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=format_name:stream=codec_type,codec_name',
          '-of',
          'json',
          absolute,
        ]),
      ) as { streams?: Array<{ codec_type?: string; codec_name?: string }> };
      audioCodecs = (metadata.streams ?? [])
        .filter(stream => stream.codec_type === 'audio')
        .map(stream => stream.codec_name ?? '');
    } catch (error) {
      issues.push({
        level: 'blocked',
        code: 'reference-media-unreadable',
        subject: reference.asset,
        message: `Reference video ${reference.asset} could not be read or probed (${error instanceof Error ? error.message : String(error)}), so it cannot be transmitted. This is an unreadable/missing file, not a model constraint; restore the Asset bytes or use another reference.`,
      });
      continue;
    }
    try {
      // The effective definition's reference profile runs for every protocol,
      // including the vendor lanes (whose adapters run it before submission too).
      effective?.model.validateReference?.(reference as never, media as never, audioCodecs);
    } catch (error) {
      issues.push({
        level: 'blocked',
        code: 'reference-media-invalid',
        subject: reference.asset,
        message: `Reference video ${reference.asset} does not meet model ${source.model}'s reference-video constraints: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return issues;
}

/**
 * Read this Source's OWN attempt record through the adapter that would run it.
 *
 * A configured Endpoint names the lane, so only that adapter's record is
 * relevant: a record written by a different protocol is bound to a different
 * service and must not be adopted. With NO configured Endpoint the only useful
 * fact is that a previous run already produced local bytes, so every adapter is
 * asked and the first record found decides.
 *
 * Read-only: one JSON per candidate adapter and hash checks for recorded local
 * outputs; no credential, reference probing, upload, or network call.
 */
async function inspectProviderAttempt(context: SourceContext, video: ProviderSource): Promise<AttemptInspection> {
  const config = context.providers?.videoApi?.[video.endpoint] ?? {};
  const assets = context.project.assets;
  if (config.endpoint || config.testOnly) {
    const protocol = videoServiceProtocol(config);
    if (protocol === 'runway-v1') return inspectRunwayAttempt(context.loadRoot, video, assets, config);
    if (protocol === 'fal-queue') return inspectFalAttempt(context.loadRoot, video, assets, config);
    return inspectVideoApiAttempt(context.loadRoot, video, assets, config);
  }
  for (const inspect of [
    () => inspectVideoApiAttempt(context.loadRoot, video, assets),
    () => inspectRunwayAttempt(context.loadRoot, video, assets),
    () => inspectFalAttempt(context.loadRoot, video, assets),
  ]) {
    const inspection = await inspect();
    if (inspection.record !== null) return inspection;
  }
  return inspectVideoApiAttempt(context.loadRoot, video, assets);
}

/** Whether a base URL leaves this machine (a loopback deployment does not). */
function isExternalOrigin(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return !(host === '127.0.0.1' || host === '::1' || host === 'localhost');
  } catch {
    return true;
  }
}

const providerExecutor: SourceExecutor = {
  kind: 'provider',
  // A `provider` Source declares its medium explicitly (`output: 'picture'`). The
  // contract admits picture only — there is no provider AUDIO-ONLY generation
  // route — but a returned video Take may itself carry native audio, which is
  // probed and kept. So `output` names the produced medium, not "silent".
  outputOf: source => (source as ProviderSource).output,
  // The video implementation closure is scoped by protocol in `build/identity.ts`
  // (its vendor adapters/routing are leaf-hashed to keep cross-vendor isolation),
  // so no static module list is declared here.
  implementationModules: [],
  tools: {},
  proxyRasterFor: () => false,
  staticFrames: () => undefined,
  staticAudio: () => undefined,
  probeAsset: () => undefined,
  testOnly: (source, providers) => Boolean(providers?.videoApi?.[(source as ProviderSource).endpoint]?.testOnly),
  // A fixture never leaves the machine. A loopback PRODUCTION deployment (a
  // self-hosted service on 127.0.0.1) also stays local, so the fact comes from the
  // configured service ADDRESS — never from "it needs no key" or "it has no cost":
  // a local deployment may still bill and still authenticate. An unconfigured
  // binding stays external (conservative): the Build cannot know where it points.
  external: (source, testOnly, providers) => {
    if (testOnly) return false;
    const baseUrl = providers?.videoApi?.[(source as ProviderSource).endpoint]?.endpoint?.baseUrl;
    return baseUrl === undefined ? true : isExternalOrigin(baseUrl);
  },
  simulated: (source, project, testOnly) => {
    if (testOnly) return true;
    const video = source as ProviderSource;
    return video.references.some(id => project.assets.find(asset => asset.id === id.asset)?.simulated);
  },
  resolve: async (source, context) => generationResolved(source as ProviderSource, context),
  identify: async (source, resolved, context) => {
    const video = source as ProviderSource;
    const config = context.providers?.videoApi?.[video.endpoint] ?? {};
    const protocol = videoServiceProtocol(config);
    // The locators participate in the Operation key ONLY when the selected
    // protocol actually transmits references through them (the generic
    // vllm-omni-video/ark transport), and only for references it transmits. Changing a
    // locator the lane ignores (any vendor protocol, or an undeclared reference)
    // must NOT read as a different request.
    const transmitted = new Set(
      transmittedReferences(protocol, video.references ?? []).map(reference => reference.asset),
    );
    const usedLocators = Object.fromEntries(
      Object.entries(config.referenceLocators ?? {}).filter(([asset]) => transmitted.has(asset)),
    );
    const providerIdentity = {
      provider: 'video-api',
      protocol,
      model: video.model,
      binding: video.endpoint,
      // The EFFECTIVE definition+mapping (caller's, else the packaged default for
      // a vendor protocol) participates, so a change to, e.g., the packaged
      // Runway mapping invalidates a Runway Source even when the project named no
      // extension.
      extensionHash: await generationExtensionIdentity({
        extension: resolveEffectiveExtension(video.model, protocol, config),
        modelSettings: config.endpoint?.modelSettings,
      }),
      ...(isVendorProtocol(protocol) ? {} : { locatorHash: stableHash(usedLocators) }),
      endpointHash: stableHash(config.endpoint ?? null),
      fixtureHash: stableHash(config.testOnly ?? null),
    };
    const implementationFiles = resolveEffectiveExtension(video.model, protocol, config)?.implementationFiles;
    return {
      inputs: [stableHash(video.prompt), ...resolved.resolvedReferences.map(asset => asset.sha256)],
      parameters: { source: video, output: context.output, bindingAssets: [], providerIdentity },
      protocol,
      ...(implementationFiles ? { implementationFiles } : {}),
    };
  },
  backendLabel: (source, providers) => {
    const video = source as ProviderSource;
    const config = providers?.videoApi?.[video.endpoint] ?? {};
    return `${videoServiceProtocol(config)}/${video.model}${config.testOnly ? '/test-only' : ''}`;
  },
  // Async: the attempt record is read through the same async loader the adapter
  // uses at execution. The hook performs no submission, upload or Project write.
  classify: async (source, context, out) => {
    const video = source as ProviderSource;
    const config = context.providers?.videoApi?.[video.endpoint];
    const approval = (code: string, message: string) =>
      out.requiresApproval.push({ level: 'requires_approval', code, subject: video.id, message });
    const configure = (code: string, message: string) =>
      out.needsConfiguration.push({ level: 'needs_configuration', code, subject: video.id, message });
    const block = (code: string, message: string) =>
      out.blockers.push({ level: 'blocked', code, subject: video.id, message });
    const lengthPending = () =>
      out.pending.push({
        level: 'pending',
        code: 'generated-length-unknown',
        subject: video.id,
        message: `Source ${video.id} requests ${video.requestedFrames} frames; a real service may decode a different count, which is verified after the run.`,
      });

    // The attempt record decides FIRST whether this Source would submit at all.
    // Reading it is the same fact the adapter enforces at execution, so Plan and
    // Produce cannot disagree about authorization. It hash-checks any recorded
    // local output but makes no network call or reference upload, so a resumable
    // attempt is recognized even when its original reference or Endpoint is gone.
    let inspection: AttemptInspection;
    try {
      inspection = await inspectProviderAttempt(context, video);
    } catch (error) {
      block(
        'provider-attempt-unreadable',
        `Source ${video.id} has an attempt record that could not be read (${error instanceof Error ? error.message : String(error)}). Inspect the recorded job before treating this request as new; it may already have been submitted.`,
      );
      return;
    }
    switch (inspection.verdict) {
      case 'mismatch':
        block(
          'provider-attempt-request-changed',
          `Video Source ${video.id}: ${inspection.reason}. An attempt is one frozen request; author a new attempt id for the changed request.`,
        );
        return;
      case 'indeterminate':
        block(
          'provider-submit-indeterminate',
          `Video Source ${video.id}: ${inspection.reason}. Create a new attempt id only if the original produced nothing.`,
        );
        return;
      case 'terminal':
        block(
          'provider-attempt-terminal',
          `Video Source ${video.id}: ${inspection.reason}. Create a new attempt id to retry.`,
        );
        return;
      case 'complete':
        out.pending.push({
          level: 'pending',
          code: 'provider-attempt-local',
          subject: video.id,
          message: `Video Source ${video.id}: ${inspection.reason}; the Build needs no service request, credential or new authorization.`,
        });
        return;
      case 'resume': {
        // Continuing a KNOWN task: no new spend or upload consent is asked for.
        if (!config?.testOnly && !config?.endpoint) {
          configure(
            'video-endpoint-not-configured',
            `Video Source ${video.id} has an attempt to resume, but endpoint "${video.endpoint}" is not configured; ${endpointHint(video.endpoint)}.`,
          );
          return;
        }
        let lane: VideoLaneResolution;
        try {
          lane = resolveVideoLane({ endpoint: config?.endpoint, testOnly: config?.testOnly }, video, 'Video preflight');
        } catch (error) {
          block(
            'video-endpoint-invalid',
            `Video Source ${video.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        if (!lane.testOnly && lane.credentialName && !lane.credentialPresent) {
          configure(
            'video-credential-missing',
            `Video Source ${video.id} needs credential ${lane.credentialName} to continue its existing task, which is neither in the environment nor stored: ${credentialSetupHint(lane.credentialName)}.`,
          );
          return;
        }
        out.pending.push({
          level: 'pending',
          code: 'provider-attempt-resume',
          subject: video.id,
          message: `Video Source ${video.id}: ${inspection.reason}. Continuing it needs no new submission or upload authorization.`,
        });
        lengthPending();
        return;
      }
      case 'new':
        break;
    }

    // From here on the Build WOULD submit a new request, so every configuration,
    // definition, credential and consent gate applies.
    // The Endpoint is resolved by the SAME `resolveVideoLane` the adapter uses, so
    // a plaintext remote HTTP base URL, an unknown protocol or a bad test-only
    // override is a BLOCKER here exactly as it would be at execution.
    if (!config?.testOnly && !config?.endpoint) {
      configure(
        'video-endpoint-not-configured',
        `Video Source ${video.id} binds endpoint "${video.endpoint}", which is not configured; ${endpointHint(video.endpoint)}.`,
      );
      lengthPending();
      return;
    }
    let lane: VideoLaneResolution;
    try {
      lane = resolveVideoLane({ endpoint: config?.endpoint, testOnly: config?.testOnly }, video, 'Video preflight');
    } catch (error) {
      out.blockers.push({
        level: 'blocked',
        code: 'video-endpoint-invalid',
        subject: video.id,
        message: `Video Source ${video.id}: ${error instanceof Error ? error.message : String(error)}`,
      });
      lengthPending();
      return;
    }
    // The model DEFINITION this request executes is selected by the canonical
    // `(source.model, lane.protocol)` — never the deployment alias
    // `endpoint.model`. Zero packaged matches with no explicit extension, for a
    // request that NEEDS a definition, is configuration the USER must supply.
    const hasDefinition = Boolean(config?.extension) || packagedExtensionFor(video.model, lane.protocol) !== undefined;
    if (!hasDefinition && requiresModelDefinition(video, lane.protocol)) {
      const packaged = packagedModelsForProtocol(lane.protocol);
      configure(
        'video-model-not-configured',
        `Video Source ${video.id} uses model "${video.model}", which has no packaged definition for protocol "${lane.protocol}". ` +
          (packaged.length
            ? `Packaged canonical model(s) for this protocol: ${packaged.map(model => `"${model}"`).join(', ')}. `
            : 'No packaged model is defined for this protocol. ') +
          `Write one of those canonical model names on the Source, or supply the definition explicitly with providers.videoApi["${video.endpoint}"].extension.`,
      );
      lengthPending();
      return;
    }
    if (lane.testOnly) {
      out.pending.push({
        level: 'pending',
        code: 'video-testonly',
        subject: video.id,
        message: `Video Source ${video.id} is bound to a loopback test fixture; the result is simulated.`,
      });
    } else if (lane.credentialName && !lane.credentialPresent) {
      configure(
        'video-credential-missing',
        `Video Source ${video.id} endpoint "${video.endpoint}" needs credential ${lane.credentialName}, which is neither in the environment nor stored: ${credentialSetupHint(lane.credentialName)}.`,
      );
    } else if (config?.authorization?.submit !== true) {
      // A loopback PRODUCTION deployment stays on this machine, so it must not be
      // described as a remote spend — but "local" is not evidence that it is free
      // or that it needs no credential, so the real scope is still stated.
      const localService = config?.endpoint?.baseUrl !== undefined && !isExternalOrigin(config.endpoint.baseUrl);
      approval(
        'video-submit-not-authorized',
        localService
          ? `Video Source ${video.id} is not authorized for submission; set providers.videoApi["${video.endpoint}"].authorization.submit = true after the user has agreed to it. This Endpoint is a local deployment: use its real cost and transfer scope rather than assuming it is free.`
          : `Video Source ${video.id} is not authorized for submission; set providers.videoApi["${video.endpoint}"].authorization.submit = true only after the user approves the spend and the media transfer.`,
      );
    } else {
      const missing = lane.uploadAssetIds.filter(id => !config.authorization?.uploadAssets?.includes(id));
      if (missing.length > 0)
        approval(
          'video-upload-not-authorized',
          `Video Source ${video.id} would transmit reference Asset(s) ${missing.join(', ')} to the selected service; add each to providers.videoApi["${video.endpoint}"].authorization.uploadAssets to grant per-Asset transmission consent.`,
        );
    }
    lengthPending();
  },
  requestIssues: async (source, context) => {
    const video = source as ProviderSource;
    const issues: ExecutorIssue[] = [];
    const config = context.providers?.videoApi?.[video.endpoint] ?? {};
    // A request that would NOT be submitted (resume / already complete /
    // terminal / changed) is not re-validated here: the Build will not send it,
    // and reporting a model-rule failure against a run that is merely continuing
    // would be a false blocker. Re-validating a resumed request also required
    // reading reference media again, which is exactly what a resume must not
    // depend on.
    let inspection: AttemptInspection;
    try {
      inspection = await inspectProviderAttempt(context, video);
    } catch (error) {
      issues.push({
        level: 'blocked',
        code: 'provider-attempt-unreadable',
        subject: video.id,
        message: `Source ${video.id} has an attempt record that could not be read (${error instanceof Error ? error.message : String(error)}); do not treat it as a new request.`,
      });
      return issues;
    }
    if (inspection.verdict !== 'new') {
      // A missing file is compatible with resuming a persisted task that never
      // needs to upload its reference again. A file that is present but differs
      // from its declared SHA is a changed author input and invalidates both a
      // resumable request and any cached operation identity.
      for (const reference of video.references) {
        const asset = context.project.assets.find(candidate => candidate.id === reference.asset);
        if (!asset) continue;
        let actual = context.files.get(asset.path);
        if (actual === undefined) {
          try {
            actual = await hashFile(await resolveProjectPath(context.loadRoot, asset.path));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            issues.push({
              level: 'blocked',
              code: 'reference-media-unreadable',
              subject: asset.id,
              message: `Reference Asset ${asset.id} for Source ${video.id} is present in the Project but cannot be verified: ${error instanceof Error ? error.message : String(error)}.`,
            });
            return issues;
          }
        }
        if (actual !== undefined && actual !== asset.sha256) {
          issues.push({
            level: 'blocked',
            code: 'reference-media-changed',
            subject: asset.id,
            message: `Reference Asset ${asset.id} is present for Source ${video.id}, but its current bytes do not match the recorded Asset digest. Restore the declared bytes or update the Asset and author a new request; the existing task will not be resubmitted.`,
          });
          return issues;
        }
      }
    }
    if (inspection.verdict !== 'new') return issues;
    // Reading a reference is a separate FACT from judging the model's rules over
    // it. A missing Asset, an unreadable file or a failed probe is reported as
    // `reference-media-unreadable`; only a successful observation that the model
    // then refuses is a model constraint violation.
    const unreadable: ExecutorIssue[] = [];
    const referenceFactsOf = async (refs: readonly { asset: string }[]) => {
      const facts: Awaited<ReturnType<typeof referenceFacts>>[] = [];
      for (const ref of refs) {
        const asset = context.project.assets.find(a => a.id === ref.asset);
        if (!asset) {
          unreadable.push({
            level: 'blocked',
            code: 'reference-media-unreadable',
            subject: ref.asset,
            message: `Reference Asset ${ref.asset} is declared by Source ${video.id} but is not in the project, so it cannot be read or transmitted. This is a missing Asset, not a model constraint.`,
          });
          return null;
        }
        try {
          facts.push(await referenceFacts(context.loadRoot, asset, ref as never));
        } catch (error) {
          unreadable.push({
            level: 'blocked',
            code: 'reference-media-unreadable',
            subject: ref.asset,
            message: `Reference Asset ${ref.asset} could not be read or probed (${error instanceof Error ? error.message : String(error)}), so it cannot be transmitted. This is an unreadable/missing file, not a model constraint; restore the Asset bytes or use another reference.`,
          });
          return null;
        }
      }
      return facts;
    };
    let effective = resolveEffectiveExtension(video.model, videoServiceProtocol(config), config);
    try {
      // A Source with NO configured deployment is classified by `classify` as the
      // `video-endpoint-not-configured` APPROVAL, not a blocker; there is no lane
      // to prepare a request against, so preparation is skipped here and the
      // approval remains the gate.
      if (config.testOnly || config.endpoint) {
        const protocol = videoServiceProtocol(config);
        // The model DEFINITION is selected by the canonical `(source.model,
        // protocol)` — never the deployment alias. When no explicit extension and
        // no packaged definition supplies a REQUIRED definition, the gap is
        // `needs_configuration` (reported by `classify`), NOT a request blocker.
        if (
          !config.extension &&
          packagedExtensionFor(video.model, protocol) === undefined &&
          requiresModelDefinition(video, protocol)
        ) {
          return issues;
        }
        // ONE read-only preparation: resolve the binding + effective definition,
        // normalize parameters, validate the model and the service subset, build
        // the mapping body and encode — exactly what Build/direct SDK run.
        // The declared references carry their REAL file size (metadata only, no
        // media read) so an oversized reference is a Plan blocker with no POST.
        const declaredReferences = video.references
          .map(reference => ({
            asset: context.project.assets.find(candidate => candidate.id === reference.asset),
            root: context.loadRoot,
          }))
          .filter((entry): entry is { asset: Asset; root: string } => entry.asset !== undefined);
        const prepared = prepareVideoRequest(video, { ...config, references: declaredReferences });
        effective = prepared.extension;
        await generationExtensionIdentity({ extension: effective, modelSettings: config.endpoint?.modelSettings });
        // Every NEW provider request must prove its real reference bytes exist
        // before Build starts any earlier Source that may submit. This is
        // independent of model-specific set validation: a mapping without that
        // hook still cannot upload a missing, stale, or unreadable reference.
        const facts = await referenceFactsOf(video.references);
        if (facts === null) return [...issues, ...unreadable];
        if (effective && (effective.model.validateReferenceSet || effective.mapping.validateReferenceSet)) {
          validateGenerationReferenceSet(effective, video, facts);
        }
        const locators = config.referenceLocators;
        for (const ref of video.references) {
          const locator = locators?.[ref.asset];
          const asset = context.project.assets.find(a => a.id === ref.asset);
          if (locator && asset) validateReferenceLocator(ref.asset, asset.sha256, locator, config.testOnly?.baseUrl);
          if (videoServiceProtocol(config) === 'ark-video-v3' && ref.category === 'video') {
            if (!locators?.[ref.asset] || locators[ref.asset].sha256 !== asset?.sha256)
              throw new Error(
                `Ark reference video ${ref.asset} requires a hosted locator bound to the frozen Asset sha256`,
              );
          }
        }
      }
    } catch (error) {
      issues.push({
        level: 'blocked',
        code: 'model-request-invalid',
        subject: video.id,
        message: `Source ${video.id} is invalid for model ${video.model}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [...issues, ...unreadable];
    }
    issues.push(...unreadable);
    issues.push(...(await referenceMediaIssues(context, video, effective)));
    return issues;
  },
  produce: async (source, resolved, context) => {
    const video = source as ProviderSource;
    const result = await generateVideoService(context.root, video, context.output, context.destination, {
      ...context.providers?.videoApi?.[video.endpoint],
      references: resolved.generationReferences.map((_reference, index) => ({
        asset: resolved.resolvedReferences[index],
        root: context.frozenRoot,
      })),
    });
    return { generation: result.generation };
  },
};

/** The endpoint configuration hint used by the provider classifier. */
function endpointHint(endpoint: string): string {
  return `add it to the user's video endpoints in ${userEndpointsFile()} (\`viscraft auth status\` shows what is configured), or pass providers.videoApi["${endpoint}"].endpoint`;
}

export { providerExecutor };
