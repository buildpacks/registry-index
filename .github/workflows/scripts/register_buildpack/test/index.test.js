import {afterEach, beforeEach, describe, it} from 'mocha'
import * as Sinon from 'sinon'
import {Octokit} from '@octokit/rest'
import * as Chai from 'chai'
import * as Registry from '../index'

const chaiAsPromised = require('chai-as-promised');
Chai.use(chaiAsPromised)

const assert = Chai.assert
const expect = Chai.expect

describe('index', function () {
    const issueContext = {
        payload: {
            sender: {
                id: 11111,
                login: 'elbandito'
            },
            issue: {
                number: 3117,
                title: 'ADD heroku/java@0.0.0',
                body: 'id = "heroku/java"\n' +
                    'version = "0.0.0"\n' +
                    'addr = "gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"'
            }
        }
    }

    let buildpackInfo = {
        ns: 'heroku',
        name: 'java',
        version: '0.0.0',
        yanked: false,
        addr: 'gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d'
    }

    const owners = '{"owners":[{"id":11111,"type":"github_user"}]}'

    describe('#validateIssue', () => {
        it('should validate successfully', () => {
            const expectedResult = {
                ns: 'heroku',
                name: 'java',
                version: '0.0.0',
                yanked: false,
                addr: 'gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d'
            }
            const result = Registry.validateIssue({context: issueContext})
            expect(result).to.deep.equal(expectedResult)
        });

        it('should throw error for missing title', () => {
            const context = {context: {
                    payload: {
                        issue: {
                            title: '',
                        }
                    }
                }
            }

            expect(() => Registry.validateIssue(context)).to.throw('issue title is missing');
        })

        it('should throw error for missing ADD verb in title', () => {
            const context = {context: {
                    payload: {
                        issue: {
                            title: 'heroku/java@0.0.0',
                        }
                    }
                }
            }

            expect(() => Registry.validateIssue(context)).to.throw('issue should contain ADD');
        })

        it('should throw error for invalid semver', () => {
            const issueContext = {
                payload: {
                    issue: {
                        title: 'ADD heroku/java@0.0.0',
                        body: 'id = "heroku/java"\n' +
                            'version = "0.0.0.0"\n' +
                            'addr = "gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"'
                    }
                }
            }

            expect(() => Registry.validateIssue({context: issueContext})).to.throw('Error: invalid semver')
        })

        it('should throw error for invalid toml', () => {
            const issueContext = {
                payload: {
                    issue: {
                        title: 'ADD heroku/java@0.0.0',
                        body: '"heroku/java"\n' +
                            'version "0.0.0.0"\n' +
                            'addr "gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"'
                    }
                }
            }

            expect(() => Registry.validateIssue({context: issueContext})).to.throw('issue with TOML: Expected "=" or [ \\t] but "\\n" found.')
        })

        it('should throw error for invalid addr field', () => {
            const badAddrIssueContext = {
                payload: {
                    sender: {
                        id: 11111,
                        login: 'elbandito'
                    },
                    issue: {
                        number: 3117,
                        title: 'ADD heroku/java@0.0.0',
                        body: 'id = "heroku/java"\n' +
                            'version = "0.0.0"\n' +
                            'addr = "gcr.io/heroku/java:tag@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"'
                    }
                }
            }

            expect(() => Registry.validateIssue({context: badAddrIssueContext})).to.throw('Error: invalid addr')
        })

        it('should throw error if namespace is restricted', () => {
            const context = {
                payload: {
                    sender: {
                        id: 11111,
                        login: 'elbandito'
                    },
                    issue: {
                        number: 3117,
                        title: 'ADD example/java@0.0.0',
                        body: 'id = "example/java"\n' +
                            'version = "0.0.0"\n' +
                            'addr = "gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"'
                    }
                }
            }
            expect(() => Registry.validateIssue({context: context})).to.throw('"example" is a restricted namespace')
        })
    });

    describe('#retrieveOwners', () => {
        const octokit = new Octokit();

        const expectedCreateOrUpdateFileArgs = {
            owner: 'owner',
            repo: 'repo',
            path: 'v1/heroku.json',
            message: 'initial commit',
            content: 'eyJvd25lcnMiOlt7ImlkIjoxMTExMSwidHlwZSI6ImdpdGh1Yl91c2VyIn1dfQ==',
            committer: {
                name: 'owner',
                email: 'cncf-buildpacks-maintainers@lists.cncf.io'
            },
            author: {
                name: 'owner',
                email: 'cncf-buildpacks-maintainers@lists.cncf.io'
            }
        }

        const expectedGetContentArgs = {
            owner: 'owner',
            path: 'v1/heroku.json',
            repo: 'repo'
        }

        let sandbox
        beforeEach(() => {
            sandbox = Sinon.createSandbox()
        })

        afterEach(() => {
            sandbox.restore()
        })

        it('should create the owners json file when missing', async () => {
            const getContentStub = sandbox.stub().throws({status: 404})
            const createOrUpdateFileContentsStub = sandbox.stub()

            octokit.repos.getContent = getContentStub
            octokit.repos.createOrUpdateFileContents = createOrUpdateFileContentsStub

            const result = await Registry.retrieveOwners(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'owner',
                'repo',
                'v1'
            )

            expect(getContentStub.callCount).to.equal(1)
            expect(getContentStub.firstCall.args[0]).to.deep.equal(expectedGetContentArgs)
            expect(createOrUpdateFileContentsStub.callCount).to.equal(1)
            expect(createOrUpdateFileContentsStub.firstCall.args[0]).to.deep.equal(expectedCreateOrUpdateFileArgs)
            expect(result).to.equal('{"owners":[{"id":11111,"type":"github_user"}]}')
        })

        it('should successfully retrieve existing owners content', async () => {
            const getContentStub = sandbox.stub().returns({
                data: {
                    content: toBase64(owners)
                }
            })
            octokit.repos.getContent = getContentStub;

            const result = await Registry.retrieveOwners(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'owner',
                'repo',
                'v1'
            )

            expect(getContentStub.callCount).to.equal(1)
            expect(getContentStub.firstCall.args[0]).to.deep.equal(expectedGetContentArgs)
            expect(result).to.equal('{"owners":[{"id":11111,"type":"github_user"}]}')
        })

        it('should successfully retrieve existing owners content', async () => {
            const getContentStub = sandbox.stub().throws(new Error({status: 500}))
            octokit.repos.getContent = getContentStub;

            const args = [
                {github: octokit, context: issueContext},
                buildpackInfo,
                'owner',
                'repo',
                'v1'
            ]

            await expect(Registry.retrieveOwners(...args)).to.be.rejectedWith(Error)
        })
    })

    describe('#isAuthorized', () => {
        let sandbox
        beforeEach(() => {
            sandbox = Sinon.createSandbox()
        })

        afterEach(() => {
            sandbox.restore()
        })

        it('should authorize github users', async () => {
            const result = await Registry.isAuthorized(
                {github: {}, context: issueContext},
                JSON.parse(owners).owners
            )

            expect(result).to.equal(true)
        })

        it('should authorize github organizations', async () => {
            const octokit = new Octokit();
            const listForUserStub = sandbox.stub().returns({
                data: [
                    {id: 12345}
                ]
            })
            octokit.orgs.listForUser = listForUserStub;

            const result = await Registry.isAuthorized(
                {github: octokit, context: issueContext},
                [{id: 12345, type: 'github_org'}]
            )

            expect(listForUserStub.callCount).to.equal(1)
            expect(listForUserStub.firstCall.args[0]).to.deep.equal({username: 'elbandito'})
            expect(result).to.equal(true)
        })

        it('should NOT authorize non github users and orgs', async () => {
            const octokit = new Octokit();
            const listForUserStub = sandbox.stub().returns({data: []})
            octokit.orgs.listForUser = listForUserStub;


            const result = await Registry.isAuthorized(
                {github: octokit, context: issueContext},
                [{id: 10000, type: 'github_user'}]
            )

            expect(listForUserStub.callCount).to.equal(1)
            expect(listForUserStub.firstCall.args[0]).to.deep.equal({username: 'elbandito'})
            expect(result).to.equal(false)
        })

        it('should throw unrecoverable Github API errors', async () => {
            const octokit = new Octokit();
            const expectedError = new Error();
            octokit.orgs.listForUser = sandbox.stub().throws(expectedError)

            const args = [
                {github: octokit, context: issueContext},
                [{id: 10000, type: 'github_user'}]
            ]

            try {
                await Registry.isAuthorized(...args)
                assert(false)
            } catch (error) {
                expect(error).to.equal(expectedError)
            }
        })
    })

    describe('#indexRegistryForBuildpack', () => {
        const existingFileContent = '{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}'
        const expectedMessage = 'ADD heroku/java@0.0.0'
        const expectedCommiter = {
            name: 'buildpacks',
            email: 'cncf-buildpacks-maintainers@lists.cncf.io'
        }
        const expectedAuthor = {
            name: 'buildpacks',
            email: 'cncf-buildpacks-maintainers@lists.cncf.io'
        }
        const bogusSHA = 'sha256:123456789'

        let sandbox
        beforeEach(() => {
            sandbox = Sinon.createSandbox()
        })

        afterEach(() => {
            sandbox.restore()
        })

        it('should index a buildpack with name length 1 into an exiting index file', async () => {
            const octokit = new Octokit();
            const createOrUpdateFileContentsStub = sandbox.stub()
            const getContentStub = sandbox.stub().returns({
                data: {
                    content: toBase64(existingFileContent),
                    sha: bogusSHA
                }
            })

            octokit.repos.createOrUpdateFileContents = createOrUpdateFileContentsStub;
            octokit.repos.getContent = getContentStub;

            buildpackInfo = {
                ns: 'heroku',
                name: 'j',
                version: '0.0.0',
                yanked: false,
                addr: 'gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d'
            }

            const expectedFileContent = toBase64(`${existingFileContent}
{"ns":"heroku","name":"j","version":"0.0.0","yanked":false,"addr":"gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}`)

            const expectedCreateOrUpdateFileContentsArgs = {
                owner: 'buildpacks',
                repo: 'repo',
                path: '1/heroku_j',
                message: expectedMessage,
                content: expectedFileContent,
                committer: expectedCommiter,
                author: expectedAuthor,
                sha: bogusSHA
            }

            await Registry.indexRegistryForBuildpack(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'buildpacks',
                'repo'
            )

            expect(createOrUpdateFileContentsStub.callCount).to.equal(1)
            expect(createOrUpdateFileContentsStub.firstCall.args[0]).to.deep.equal(expectedCreateOrUpdateFileContentsArgs)
        })

        it('should index a buildpack with name length 2 into an exiting index file', async () => {
            const octokit = new Octokit();
            const existingFileContent = '{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}'

            const createOrUpdateFileContentsStub = sandbox.stub()
            const getContentStub = sandbox.stub().returns({
                data: {
                    content: toBase64(existingFileContent),
                    sha: bogusSHA
                }
            })

            octokit.repos.createOrUpdateFileContents = createOrUpdateFileContentsStub;
            octokit.repos.getContent = getContentStub;

            buildpackInfo = {
                ns: 'heroku',
                name: 'ru',
                version: '0.0.0',
                yanked: false,
                addr: 'gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d'
            }

            const expectedFileContent = toBase64(`{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}
{"ns":"heroku","name":"ru","version":"0.0.0","yanked":false,"addr":"gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}`)

            const expectedCreateOrUpdateFileContentsArgs = {
                owner: 'buildpacks',
                repo: 'repo',
                path: '2/heroku_ru',
                message: expectedMessage,
                content: expectedFileContent,
                committer: expectedCommiter,
                author: expectedAuthor,
                sha: bogusSHA
            }

            await Registry.indexRegistryForBuildpack(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'buildpacks',
                'repo'
            )

            expect(createOrUpdateFileContentsStub.callCount).to.equal(1)
            expect(createOrUpdateFileContentsStub.firstCall.args[0]).to.deep.equal(expectedCreateOrUpdateFileContentsArgs)
        })

        it('should index a buildpack with name length 3 into an exiting index file', async () => {
            const octokit = new Octokit();
            const existingFileContent = '{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}'

            const createOrUpdateFileContentsStub = sandbox.stub()
            const getContentStub = sandbox.stub().returns({
                data: {
                    content: toBase64(existingFileContent),
                    sha: bogusSHA
                }
            })

            octokit.repos.createOrUpdateFileContents = createOrUpdateFileContentsStub
            octokit.repos.getContent = getContentStub

            buildpackInfo = {
                ns: 'heroku',
                name: 'sca',
                version: '0.0.0',
                yanked: false,
                addr: 'gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d'
            }

            const expectedFileContent = toBase64(`{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}
{"ns":"heroku","name":"sca","version":"0.0.0","yanked":false,"addr":"gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}`)

            const expectedCreateOrUpdateFileContentsArgs = {
                owner: 'buildpacks',
                repo: 'repo',
                path: '3/sc/heroku_sca',
                message: expectedMessage,
                content: expectedFileContent,
                committer: expectedCommiter,
                author: expectedAuthor,
                sha: bogusSHA
            }

            await Registry.indexRegistryForBuildpack(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'buildpacks',
                'repo'
            )

            expect(createOrUpdateFileContentsStub.callCount).to.equal(1)
            expect(createOrUpdateFileContentsStub.firstCall.args[0]).to.deep.equal(expectedCreateOrUpdateFileContentsArgs)
        })

        it('should index a buildpack with name length greater than 3 into an exiting index file', async () => {
            const octokit = new Octokit();
            const existingFileContent = '{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}'

            const createOrUpdateFileContentsStub = sandbox.stub()
            const getContentStub = sandbox.stub().returns({
                data: {
                    content: toBase64(existingFileContent),
                    sha: bogusSHA
                }
            })

            octokit.repos.createOrUpdateFileContents = createOrUpdateFileContentsStub;
            octokit.repos.getContent = getContentStub;

            buildpackInfo = {
                ns: 'heroku',
                name: 'java',
                version: '0.0.0',
                yanked: false,
                addr: 'gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d'
            }

            const expectedFileContent = toBase64(`{"ns":"projectriff","name":"node-function","version":"0.6.2","yanked":false,"addr":"gcr.io/projectriff/node-function@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}
{"ns":"heroku","name":"java","version":"0.0.0","yanked":false,"addr":"gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}`)

            const expectedCreateOrUpdateFileContentsArgs = {
                owner: 'buildpacks',
                repo: 'repo',
                path: 'ja/va/heroku_java',
                message: expectedMessage,
                content: expectedFileContent,
                committer: expectedCommiter,
                author: expectedAuthor,
                sha: bogusSHA
            }

            await Registry.indexRegistryForBuildpack(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'buildpacks',
                'repo'
            )

            expect(createOrUpdateFileContentsStub.callCount).to.equal(1)
            expect(createOrUpdateFileContentsStub.firstCall.args[0]).to.deep.equal(expectedCreateOrUpdateFileContentsArgs)
        })

        it('should create a new index file when missing', async () => {
            const octokit = new Octokit();

            const createOrUpdateFileContentsStub = sandbox.stub()
            const getContentStub = sandbox.stub().throws({status: 404})

            octokit.repos.createOrUpdateFileContents = createOrUpdateFileContentsStub;
            octokit.repos.getContent = getContentStub;

            const expectedFileContent = toBase64('{"ns":"heroku","name":"java","version":"0.0.0","yanked":false,"addr":"gcr.io/heroku/java@sha256:9d88250dfd77dbf5a535f1358c6a05dc2c0d3a22defbdcd72bb8f5e24b84e21d"}')
            const expectedCreateOrUpdateFileContentsArgs = {
                owner: 'buildpacks',
                repo: 'repo',
                path: 'ja/va/heroku_java',
                message: expectedMessage,
                content: expectedFileContent,
                committer: expectedCommiter,
                author: expectedAuthor
            }

            await Registry.indexRegistryForBuildpack(
                {github: octokit, context: issueContext},
                buildpackInfo,
                'buildpacks',
                'repo'
            )

            expect(createOrUpdateFileContentsStub.callCount).to.equal(1)
            expect(createOrUpdateFileContentsStub.firstCall.args[0]).to.deep.equal(expectedCreateOrUpdateFileContentsArgs)
        })

        it('should throw unrecoverable Github API errors', async () => {
            const octokit = new Octokit();

            const expectedError = new Error()
            expectedError.status = 500

            octokit.repos.getContent = sandbox.stub().throws(expectedError)

            const args = [
                {github: octokit, context: issueContext},
                buildpackInfo,
                'buildpacks',
                'repo'
            ]

            try {
                await Registry.indexRegistryForBuildpack(...args)
                assert(false)
            } catch (error) {
                expect(error).to.equal(expectedError)
            }
        })

        it('should throw error when buildpack name is empty', async () => {
            buildpackInfo.name = ''

            const args = [
                {github: {}, context: {}},
                buildpackInfo,
                '',
                ''
            ]

            try {
                await Registry.indexRegistryForBuildpack(...args)
                assert(false)
            } catch (error) {
                expect(error.message).to.deep.equal('buildpack name cannot be empty')
            }
        })
    })

    describe('#closeIssue', () => {
        let sandbox
        beforeEach(() => {
            sandbox = Sinon.createSandbox()
        })

        afterEach(() => {
            sandbox.restore()
        })

        it('should successfully close the issue', async () => {
            const octokit = new Octokit();
            const createCommentStub = sandbox.stub()
            const updateStub = sandbox.stub()

            octokit.issues.createComment = createCommentStub
            octokit.issues.update = updateStub

            await Registry.closeIssue(
                {github: octokit, context: issueContext},
                'buildpacks',
                'repo',
                ['mytestlabel']
            )

            expect(createCommentStub.callCount).to.equal(0)
            expect(updateStub.callCount).to.equal(1)
            expect(updateStub.firstCall.args[0]).to.deep.equal({
                owner: 'buildpacks',
                repo: 'repo',
                issue_number: issueContext.payload.issue.number,
                labels: ['mytestlabel'],
                state: 'closed'
            })
        })

        it('should successfully close the issue with comment', async () => {
            const octokit = new Octokit();
            const createCommentStub = sandbox.stub()
            const updateStub = sandbox.stub()

            octokit.issues.createComment = createCommentStub
            octokit.issues.update = updateStub

            const comment = 'you did a bad thing'
            await Registry.closeIssue(
                {github: octokit, context: issueContext},
                'buildpacks',
                'repo',
                ['mytestlabel'],
                comment
            )


            expect(createCommentStub.callCount).to.equal(1)
            expect(createCommentStub.firstCall.args[0]).to.deep.equal({
                owner: 'buildpacks',
                repo: 'repo',
                issue_number: issueContext.payload.issue.number,
                body: comment
            })

            expect(updateStub.callCount).to.equal(1)
            expect(updateStub.firstCall.args[0]).to.deep.equal({
                owner: 'buildpacks',
                repo: 'repo',
                issue_number: issueContext.payload.issue.number,
                labels: ['mytestlabel'],
                state: 'closed'
            })
        })

        it('should throw unrecoverable Github API errors', async () => {
            const octokit = new Octokit();
            const expectedError = new Error('Github blew up!!')

            octokit.issues.update = sandbox.stub().throws(expectedError)

            try {
                await Registry.closeIssue(
                    {github: octokit, context: issueContext},
                    'buildpacks',
                    'repo',
                    ['mytestlabel'],
                )
                assert(false)
            } catch (error) {
                expect(error).to.equal(expectedError)
            }
        })
    })

    describe('#versionAlreadyExists', () => {
        it('should return false if the version does not exist', async () => {
            let v = await Registry.versionAlreadyExists( '{"version":"0.1.0"}', {"version":"0.2.0"})
            expect(v).to.be.false
        })

        it('should return true if the version exists', async () => {
            let v = await Registry.versionAlreadyExists( '{"version":"0.1.0"}', {"version":"0.1.0"})
            expect(v).to.be.true
        })

        it('should return false if there are no existing versions', async () => {
            let v = await Registry.versionAlreadyExists('', {"version":"0.1.0"})
            expect(v).to.be.false
        })
    })
});

// HELPER FUNCTIONS

const toBase64 = (value) => {
    const buff = Buffer.from(value, 'utf-8')
    return buff.toString('base64')
}
