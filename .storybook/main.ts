import { createEntry } from '../webpack.config'
import { StorybookConfig } from '@storybook/react-webpack5'

const config: StorybookConfig = {
    stories: ['../frontend/src/**/*.stories.@(js|jsx|ts|tsx|mdx)'],

    addons: [
        '@storybook/addon-docs',
        '@storybook/addon-links',
        '@storybook/addon-essentials',
        '@storybook/addon-storysource',
        '@storybook/addon-a11y',
        'storybook-addon-pseudo-states',
    ],

    staticDirs: ['public'],

    /**
     * Function to merge the provided config object with the main config object
     * @param {Object} config - The config object to be merged
     * @returns {Object} - The merged config object
     * @description
     *   - Create the main config object using the createEntry function
     *   - Merge the resolve extensions and alias from the config object with the main config object
     *   - Merge the module rules from the main config object with the config object
     *   - Only include rules with a test property containing '.mdx' in the merged module rules array
     */
    webpackFinal: (config) => {
        const mainConfig = createEntry('main')
        return {
            ...config,
            resolve: {
                ...config.resolve,
                extensions: [...config.resolve!.extensions!, ...mainConfig.resolve.extensions],
                alias: { ...config.resolve!.alias, ...mainConfig.resolve.alias },
            },
            module: {
                ...config.module,
                rules: [
                    ...mainConfig.module.rules,
                    ...(config.module?.rules?.filter(
                        (rule: any) => 'test' in rule && rule.test.toString().includes('.mdx')
                    ) ?? []),
                ],
            },
        }
    },

    framework: {
        name: '@storybook/react-webpack5',
        options: { builder: { useSWC: true } },
    },

    docs: {
        autodocs: 'tag',
    },

    typescript: { reactDocgen: 'react-docgen' }, // Shouldn't be needed in Storybook 8
}

export default config
