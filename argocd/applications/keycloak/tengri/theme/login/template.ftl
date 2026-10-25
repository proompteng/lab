<#-- SPDX-License-Identifier: Apache-2.0 -->
<#import "theme-resources.ftl" as themeResourceTags>
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>

<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />

    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${msg("tengriPageTitle")}</title>
    <meta name="color-scheme" content="dark" />
    <link rel="icon" type="image/svg+xml" href="${url.resourcesPath}/img/fruit-pear.svg" />
    <link rel="preload" href="${url.resourcesPath}/fonts/GeistSans.woff2" as="font" type="font/woff2" crossorigin />
    <#if themeResources?? && themeResources.stylesCommon?has_content>
        <@themeResourceTags.renderStyles themeResources.stylesCommon url.resourcesCommonPath />
    <#elseif properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if themeResources?? && themeResources.styles?has_content>
        <@themeResourceTags.renderStyles themeResources.styles url.resourcesPath />
    <#elseif properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if themeResources?? && themeResources.scripts?has_content>
        <@themeResourceTags.renderScripts themeResources.scripts url.resourcesPath "text/javascript" />
    <#elseif properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <script src="${url.resourcesPath}/js/menu-button-links.js" type="module"></script>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="module">
        <#outputformat "JavaScript">
        import { startSessionPolling } from ${(url.resourcesPath + "/js/authChecker.js")?c};

        startSessionPolling(
            ${url.ssoLoginInOtherTabsUrl?c}
        );
        </#outputformat>
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");

            if (!link) {
                return;
            }

            if (link.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
                return;
            }

            const { disabledClass } = link.dataset;

            if (disabledClass) {
                link.classList.add(...disabledClass.trim().split(/\s+/));
            }

            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
            <#outputformat "JavaScript">
            import { checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};

            checkAuthSession(
                ${authenticationSession.authSessionIdHash?c}
            );
            </#outputformat>
        </script>
    </#if>
</head>

<body class="tengri-login ${bodyClass}" data-page-id="login-${pageId}">
    <header class="tengri-menubar">
        <span class="tengri-brand">
            <img src="${url.resourcesPath}/img/fruit-pear.svg" width="20" height="20" alt="" />
            Tengri
        </span>
        <span>${msg("tengriWorkspace")}</span>
    </header>
    <main class="tengri-stage">
        <section class="tengri-window" aria-labelledby="kc-page-title">
            <div class="tengri-titlebar">
                <span class="tengri-window-controls" aria-hidden="true"><span></span><span></span><span></span></span>
                <span>${msg("tengriWindowTitle")}</span>
            </div>
            <div class="tengri-window-body">
                <header class="tengri-form-header">
                    <div class="tengri-mark" aria-hidden="true">
                        <img src="${url.resourcesPath}/img/fruit-pear.svg" width="28" height="28" alt="" />
                    </div>
                    <h1 id="kc-page-title"><#nested "header"></h1>
                    <#if pageId == "webauthn-register">
                        <p class="tengri-description">${msg("tengriRegisterDescription")}</p>
                    <#elseif pageId == "webauthn-authenticate">
                        <p class="tengri-description">${msg("tengriAuthenticateDescription")}</p>
                    </#if>
                    <#if displayRequiredFields>
                        <p class="tengri-required"><span aria-hidden="true">*</span> ${msg("requiredFields")}</p>
                    </#if>
                </header>
                <#if realm.internationalizationEnabled && locale.supported?size gt 1>
                    <nav id="kc-locale" aria-label="${msg("languages")}">
                        <#list locale.supported as l>
                            <a href="${l.url}">${l.label}</a>
                        </#list>
                    </nav>
                </#if>
                <div id="kc-content">
                    <div id="kc-content-wrapper">
                        <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                            <div class="tengri-alert alert-${message.type}" role="<#if message.type == 'error'>alert<#else>status</#if>">
                                ${kcSanitize(message.summary)?no_esc}
                            </div>
                        </#if>

                        <#nested "form">

                        <#if auth?has_content && auth.showTryAnotherWayLink()>
                            <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                                <input type="hidden" name="tryAnotherWay" value="on" />
                                <button class="tengri-secondary" id="try-another-way" type="submit">${msg("doTryAnotherWay")}</button>
                            </form>
                        </#if>
                        <#if switchOrganizationEnabled?? && switchOrganizationEnabled>
                            <form id="kc-switch-organization-form" action="${url.loginAction}" method="post">
                                <input type="hidden" name="switchOrganization" value="true" />
                                <button class="tengri-secondary" id="switch-organization" type="submit">${msg("doSwitchOrganization")}</button>
                            </form>
                        </#if>

                        <#nested "socialProviders">

                        <#if displayInfo>
                            <div id="kc-info"><#nested "info"></div>
                        </#if>
                    </div>
                </div>
                <#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
                    <div class="tengri-account">
                        <a id="reset-login" href="${url.loginRestartFlowUrl}">${msg("tengriRestartLogin")}</a>
                    </div>
                </#if>
            </div>
        </section>
    </main>
</body>
</html>
</#macro>
