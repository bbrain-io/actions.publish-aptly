import * as core from '@actions/core'
import {getOctokit} from '@actions/github'
import fs from 'fs'
import axios, {AxiosError} from 'axios'
import minimatch from 'minimatch'
import FormData from 'form-data'

function parseFiles(files: string): string[] {
  return files.split(/\r?\n/).reduce<string[]>(
    (acc, line) =>
      acc
        .concat(line.split(','))
        .filter(pat => pat)
        .map(pat => pat.trim()),
    []
  )
}

function enumFromStringValue<T>(
  enm: {[s: string]: T},
  value: string
): T | undefined {
  return (Object.values(enm) as unknown as string[]).includes(value)
    ? (value as unknown as T)
    : undefined
}

enum AuthType {
  basic = 'basic',
  token = 'token'
}

type Aptly = {
  url: string
  repo: string
  dir: string
  user?: string
  pass: string
  auth: AuthType
}

type Inputs = {
  repo: string
  owner: string
  release_tag: string
  assets: string[]
  aptly: Aptly
  github_token: string
}

function getInputObject(): Inputs {
  const auth: AuthType | undefined = enumFromStringValue(
    AuthType,
    core.getInput('aptly-auth')
  )

  if (auth === undefined) {
    throw new Error('Invalid aptly-auth value.')
  }

  const aptly: Aptly = {
    url: core.getInput('aptly-url', {required: true}),
    repo: core.getInput('aptly-repo', {required: true}),
    dir: core.getInput('aptly-dir', {required: true}),
    pass: core.getInput('aptly-pass', {required: true}),
    auth
  }

  if (auth === AuthType.basic) {
    aptly.user = core.getInput('aptly-user', {required: true})
  }

  const inputs: Inputs = {
    github_token: core.getInput('github-token', {required: true}),
    repo: core.getInput('repo', {required: true}),
    owner: core.getInput('owner', {required: true}),
    release_tag: core.getInput('release-tag', {required: true}),
    assets: parseFiles(core.getInput('assets', {required: true})),
    aptly
  }

  return inputs
}

async function createRepo(repo: string): Promise<void> {
  core.info(`Creating repo ${repo}`)
  try {
    core.debug(await axios.post('/repos', {Name: repo}))
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 400) return
    throw error
  }
}

async function uploadFile(data: FormData, dir: string): Promise<void> {
  core.info(`Uploading file to ${dir}`)
  core.debug(
    await axios.post(`/files/${dir}`, data, {
      headers: {
        ...data.getHeaders()
      }
    })
  )
}

async function addFileToRepo(
  repo: string,
  dir: string,
  file: string
): Promise<void> {
  core.info(`Adding file ${dir}/${file} to repo ${repo}`)
  core.debug(
    await axios.post(`/repos/${repo}/file/${dir}/${file}`, '', {
      params: {forceReplace: '1'}
    })
  )
}

async function updatePublishedRepo(distribution: string): Promise<void> {
  core.info(`Updating published repo with distribution ${distribution}`)
  const res = await axios.put(`/publish/:./${distribution}`)
  core.debug(res.data)
}

async function run(): Promise<void> {
  try {
    const inputs: Inputs = getInputObject()
    core.debug(JSON.stringify(inputs))
    const github = getOctokit(inputs.github_token)
    const release = await github.rest.repos.getReleaseByTag({
      owner: inputs.owner,
      repo: inputs.repo,
      tag: inputs.release_tag
    })
    const assets = release.data.assets
    const matched_assets = []
    for (const asset of assets) {
      for (const pattern of inputs.assets) {
        if (asset.name === pattern) {
          matched_assets.push(asset)
        } else if (minimatch(asset.name, pattern)) {
          matched_assets.push(asset)
        }
      }
    }
    axios.defaults.baseURL = inputs.aptly.url
    if (inputs.aptly.user) {
      axios.defaults.auth = {
        username: inputs.aptly.user,
        password: inputs.aptly.pass
      }
    } else {
      axios.defaults.headers.common = {Authorization: inputs.aptly.pass}
    }
    core.debug(JSON.stringify(matched_assets))
    await createRepo('pkger')

    for (const asset of matched_assets) {
      const res = await github.rest.repos.getReleaseAsset({
        owner: inputs.owner,
        repo: inputs.repo,
        asset_id: asset.id,
        headers: {
          Accept: 'application/octet-stream'
        }
      })
      // @ts-expect-error: Wrong return type
      fs.writeFileSync(asset.name, Buffer.from(res.data))
      const file = fs.readFileSync(asset.name)
      const form = new FormData()
      form.append('file', file, asset.name)
      await uploadFile(form, inputs.aptly.dir)
      await addFileToRepo(inputs.aptly.repo, inputs.aptly.dir, asset.name)
      await updatePublishedRepo('jammy')
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

run()
