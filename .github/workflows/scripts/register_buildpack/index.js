const Path = require('path');
const Schema = require('validate')
const Toml = require('toml')

const restrictedNamespaces = [
    "example",
    "examples",
    "sample",
    "samples",
    "official",
    "buildpack",
    "buildpacks",
    "buildpacksio",
    "buildpackio",
    "buildpacks-io",
    "buildpack-io",
    "buildpacks.io",
    "buildpack.io",
    "pack",
    "cnb",
    "cnbs",
    "cncf",
    "cncf-cnb",
    "cncf-cnbs"
]

const bodySchema = new Schema({
    id: {
        type: String,
        required: true,
        message: 'invalid id'
    },
    version: {
        type: String,
        // regex from semver official website to validate versions
        match: /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
        required: true,
        message: 'invalid semver'
    },
    addr: {
        type: String,
        match: /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9](?::[0-9]+)?\/[^:]+@sha256:[A-Fa-f0-9]{64}/,
        required: true,
        message: 'invalid addr'
    },
})

const toBase64 = (value) => {
    const buff = Buffer.from(value, 'utf-8')
    return buff.toString('base64')
}

const createOrUpdateFileContents = async (path, message, content, github, owner, repo, sha = '') => {
    let params = {
        owner,
        repo,
        path,
        message,
        content,
        committer: {
            name: owner,
            email: 'cncf-buildpacks-maintainers@lists.cncf.io'
        },
        author: {
            name: owner,
            email: 'cncf-buildpacks-maintainers@lists.cncf.io'
        }
    }
    if (sha !== '') {
        params = {...params, ...{sha}};
    }
    try {
        await github.repos.createOrUpdateFileContents(params)
    } catch (error) {
        throw error
    }
}

function validateIssue({context}) {
    if (context.payload.issue.title === "") {
        throw new Error("issue title is missing")
    }
    if (!context.payload.issue.title.includes('ADD')) {
        throw new Error("issue should contain ADD")
    }

    let tomlData
    try {
        tomlData = Toml.parse(context.payload.issue.body)
    } catch (err) {
        throw new Error(`issue with TOML: ${err.message}`)
    }

    const errors = bodySchema.validate(tomlData)
    if (errors && errors.length > 0) {
        throw new Error(`${errors}`)
    }

    buildpackInfo = {
        ns: tomlData.id.split("/")[0],
        name: tomlData.id.split("/")[1],
        version: tomlData.version,
        yanked: false,
        addr: tomlData.addr
    }

    if (restrictedNamespaces.includes(buildpackInfo.ns)) {
        throw new Error(`"${buildpackInfo.ns}" is a restricted namespace`)
    }

    return buildpackInfo
}

async function retrieveOwners({github, context}, buildpackInfo, owner, repo, version) {
    let registryOwners = ''
    try {
        const {data} = await github.repos.getContent({
            owner,
            path: `${version}/${buildpackInfo.ns}.json`,
            repo
        })
        const buff = new Buffer.from(data.content, 'base64')
        registryOwners = buff.toString('utf-8')

    } catch (error) {
        if (error.status === 404) {
            console.error('Creating file since it does not exist')
            const content = {
                owners: [
                    {
                        id: context.payload.sender.id,
                        type: 'github_user'
                    }
                ]
            };
            const buff = Buffer.from(JSON.stringify(content), 'utf-8');
            registryOwners = buff.toString('utf-8')

            await github.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `${version}/${buildpackInfo.ns}.json`,
                message: 'initial commit',
                content: buff.toString('base64'),
                committer: {
                    name: owner,
                    email: 'cncf-buildpacks-maintainers@lists.cncf.io'
                },
                author: {
                    name: owner,
                    email: 'cncf-buildpacks-maintainers@lists.cncf.io'
                }
            })
        } else {
            throw error
        }
    }

    return registryOwners
}

async function isAuthorized({github, context}, owners) {
    if (!!owners.find(owner => (owner.id === context.payload.sender.id) && (owner.type === 'github_user'))) {
        console.error('user successfully authenticated via github_user')
        return true
    }

    let orgIDs = [];
    try {
        const orgs = await github.orgs.listForUser({
            username: context.payload.sender.login
        });
        orgIDs = orgs.data.map(org => org.id);

    } catch (error) {
        throw error
    }

    const filteredOwners = owners.filter(owner => (owner.type === 'github_org' && orgIDs.includes(owner.id)));
    if (filteredOwners.length > 0) {
        console.error('user successfully authenticated via github_org')
        return true
    }

    return false
}

async function indexRegistryForBuildpack({github, context}, buildpackInfo, owner, repo) {
    const nameLength = buildpackInfo.name.length

    let indexPath = ''
    if (nameLength === 1) {
        indexPath = Path.join(indexPath, '1')
    } else if (nameLength === 2) {
        indexPath = Path.join(indexPath, '2')
    } else if (nameLength === 3) {
        indexPath = Path.join(indexPath, '3', buildpackInfo.name.slice(0, 2))
    } else if (nameLength > 3) {
        indexPath = Path.join(indexPath, buildpackInfo.name.slice(0, 2), buildpackInfo.name.slice(2, 4))
    } else {
        throw new Error('buildpack name cannot be empty')
    }

    indexPath = Path.join(indexPath, `${buildpackInfo.ns}_${buildpackInfo.name}`)
    try {
        const {data} = await github.repos.getContent({
            owner,
            path: indexPath,
            repo
        })

        let buff = new Buffer.from(data.content, 'base64')
        let fileContent = buff.toString('utf-8').trimEnd()

        if (await versionAlreadyExists(fileContent, buildpackInfo)) {
            throw new Error('duplicate version')
        }

        fileContent = fileContent + "\n" + JSON.stringify(buildpackInfo)

        await createOrUpdateFileContents(
            indexPath,
            context.payload.issue.title,
            toBase64(fileContent),
            github,
            owner,
            repo,
            data.sha
        )

    } catch (error) {
        if (error.status === 404) {
            await createOrUpdateFileContents(
                indexPath,
                context.payload.issue.title,
                toBase64(JSON.stringify(buildpackInfo)),
                github,
                owner,
                repo
            )
        } else {
            throw error
        }
    }
}

async function closeIssue({github, context}, owner, repo, labels, comment = '') {
    if (comment.trim() !== '') {
        await github.issues.createComment({
            owner,
            repo,
            issue_number: context.payload.issue.number,
            body: comment,
        });
    }
    await github.issues.update({
        owner,
        repo,
        issue_number: context.payload.issue.number,
        labels,
        state: 'closed'
    })
}

async function versionAlreadyExists(existingVersions, buildpackInfo) {
    return existingVersions.split("\n").some((element, _) => {
        if (element !== "") {
            let existingVersion = JSON.parse(element)
            return existingVersion.version === buildpackInfo.version
        }
    })
}

module.exports = {
    validateIssue,
    retrieveOwners,
    isAuthorized,
    indexRegistryForBuildpack,
    closeIssue,
    versionAlreadyExists
}
