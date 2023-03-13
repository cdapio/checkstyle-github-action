import * as core from '@actions/core'
import {findResults} from './search'
import {Inputs} from './constants'
import {annotationsForPath} from './annotations'
import {chain, groupBy, splitEvery} from 'ramda'
import {Annotation, AnnotationLevel} from './github'
import {context, getOctokit} from '@actions/github'
import {GitHub} from '@actions/github/lib/utils';

const MAX_ANNOTATIONS_PER_REQUEST = 50

type Conclusions = 'success' | 'failure' | 'neutral'

async function run(): Promise<void> {
  try {
    const path = core.getInput(Inputs.Path, {required: true})
    const name = core.getInput(Inputs.Name)
    const title = core.getInput(Inputs.Title)
    const commit = core.getInput(Inputs.Commit)
    const changedSince = core.getInput(Inputs.ChangedSince)

    const octokit = getOctokit(core.getInput(Inputs.Token))

    const head_sha = commit ||
        (context.payload.pull_request && context.payload.pull_request.head.sha) ||
        context.sha;

    const filter = await getFilter(octokit, head_sha, commit, changedSince)
    core.debug(`Got the filter of ${filter} files, e.g. ${filter.slice(0, 3)}`)
    const searchResult = await findResults(path)
    if (searchResult.filesToUpload.length === 0) {
      core.warning(
        `No files were found for the provided path: ${path}. No results will be uploaded.`
      )
    } else {
      core.info(
        `With the provided path, there will be ${searchResult.filesToUpload.length} results uploaded`
      )
      core.debug(`Root artifact directory is ${searchResult.rootDirectory}`)

      const allAnnotations: Annotation[] = chain(
        annotationsForPath,
        searchResult.filesToUpload
      )
      const annotations = filter.length == 0 ? allAnnotations :
        allAnnotations.filter(annotation => filter.includes(annotation.path))

      core.debug(
        `Grouping ${annotations.length} filtered out of ${allAnnotations.length} annotations into chunks of ${MAX_ANNOTATIONS_PER_REQUEST}`
      )

      const groupedAnnotations: Annotation[][] =
        annotations.length > MAX_ANNOTATIONS_PER_REQUEST
          ? splitEvery(MAX_ANNOTATIONS_PER_REQUEST, annotations)
          : [annotations]

      core.debug(`Created ${groupedAnnotations.length} buckets`)

      const conclusion = getConclusion(annotations)
      let total = 0

      const check_run_id = await createCheck(
          octokit,
          head_sha,
          name,
          title,
          annotations.length
      )

      for (const annotationSet of groupedAnnotations) {
        await addAnnotations(
          octokit,
          head_sha,
          check_run_id,
          name,
          title,
          annotationSet,
          total,
          annotations.length,
        )
        total += annotationSet.length
      }

      await completeCheck(
          octokit,
          head_sha,
          check_run_id,
          name,
          title,
          annotations.length,
          conclusion
      )

    }
  } catch (error) {
    core.setFailed(error)
  }
}

function getConclusion(
  annotations: Annotation[]
): Conclusions {
  if (annotations.length === 0) {
    return 'success'
  }

  const annotationsByLevel: {[p: string]: Annotation[]} = groupBy(
    a => a.annotation_level,
    annotations
  )

  if (
    annotationsByLevel[AnnotationLevel.failure] &&
    annotationsByLevel[AnnotationLevel.failure].length
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return <Conclusions> core.getInput(Inputs.ErrorConclusion)
  } else if (
    annotationsByLevel[AnnotationLevel.warning] &&
    annotationsByLevel[AnnotationLevel.warning].length
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return <Conclusions> core.getInput(Inputs.WarningConclusion)
  } else if (
      annotationsByLevel[AnnotationLevel.notice] &&
      annotationsByLevel[AnnotationLevel.notice].length
  ) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return <Conclusions> core.getInput(Inputs.NoticeConclusion)
  }

  return 'success'
}

async function getFilter(
  octokit: InstanceType<typeof GitHub>,
  head_sha: string,
  commit: string,
  changedSince: string
): Promise<string[]> {
  if (changedSince == "") {
    return [];
  }

  const req = {
    ...context.repo,
    head: head_sha,
    base: changedSince
  }
  const compare = await octokit.repos.compareCommits(req)
  return compare.data.files.map(file => file.filename)
}

async function createCheck(
    octokit: InstanceType<typeof GitHub>,
    head_sha: string,
    name: string,
    title: string,
    numErrors: number,
): Promise<number> {

    const createRequest = {
      ...context.repo,
      head_sha,
      name,
      status: <const>'in_progress',
      output: {
        title,
        summary: `${numErrors} violation(s) found`,
      }
    }

  const result = await octokit.checks.create(createRequest)
  return result.data.id
}

async function addAnnotations(
  octokit: InstanceType<typeof GitHub>,
  head_sha: string,
  check_run_id: number,
  name: string,
  title: string,
  annotations: Annotation[],
  processedErrors: number,
  numErrors: number,
): Promise<void> {

  core.info(
    `Uploading ${processedErrors} + ${annotations.length} / ${numErrors} annotations GitHub check ${check_run_id}@${head_sha} as ${name}`
  )

  const update_req = {
    ...context.repo,
    check_run_id,
    output: {
      title,
      summary: `${numErrors} violation(s) found`,
      annotations
    }
  }

  await octokit.checks.update(update_req)
}

async function completeCheck(
    octokit: InstanceType<typeof GitHub>,
    head_sha: string,
    check_run_id: number,
    name: string,
    title: string,
    numErrors: number,
    conclusion: Conclusions
): Promise<void> {

  core.info(
      `Finishing GitHub check ${check_run_id}@${head_sha} as ${name} with conclusion ${conclusion}`
  )

  const update_req = {
    ...context.repo,
    conclusion,
    check_run_id,
    status: <const>'completed',
    output: {
      title,
      summary: `${numErrors} violation(s) found`,
    }
  }

  await octokit.checks.update(update_req)
}

run()
