#!/bin/sh
# ゲームの自動デプロイの用意をする（README の「GitHub Actions での自動デプロイ」の手順2・3）
# ゲームごとに、ロールのスタック（<ゲーム>-github-deploy）を作り、ロールの ARN を Secret の AWS_DEPLOY_ROLE_ARN に入れる
# IAM を作るので、ユーザーが自分で実行する
#
# 使い方: scripts/setup-github-deploy.sh <プロフィール> <ゲーム> [<ゲーム> ...]
# 例:     scripts/setup-github-deploy.sh my-profile dominion lucky-numbers
set -eu

if [ $# -lt 2 ]; then
    echo "使い方: $0 <プロフィール> <ゲーム> [<ゲーム> ...]" >&2
    exit 1
fi

profile=$1
shift
owner=123yoshidandy
region=ap-northeast-1
template="$(cd "$(dirname "$0")/.." && pwd)/template/github-deploy.yaml"

for game in "$@"; do
    echo "== $game: ロールのスタック（$game-github-deploy）"
    aws cloudformation deploy \
        --template-file "$template" \
        --stack-name "$game-github-deploy" \
        --capabilities CAPABILITY_NAMED_IAM \
        --parameter-overrides "GameName=$game" \
        --no-fail-on-empty-changeset \
        --region "$region" --profile "$profile"

    echo "== $game: Secret（AWS_DEPLOY_ROLE_ARN）"
    arn=$(aws cloudformation describe-stacks --stack-name "$game-github-deploy" \
        --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" --output text \
        --region "$region" --profile "$profile")
    gh secret set AWS_DEPLOY_ROLE_ARN --repo "$owner/$game" --body "$arn"
done

echo "完了: $*"
