import { widgets } from'./widgets.js'

const quickAccessContainer = document.getElementById("quickAccessContainer");
const moreServicesContainer = document.getElementById("moreServicesContainer");

function quickAccess(widget) {
  return `
    <div class="col-12 col-lg-4 col-xl-4 widget-block">
      <div class="featured">
        <div class="widget-block-content">

          <img
            src="${widget.image}"
            style="max-width: 48px; max-height: 48px; margin-bottom: 32px"
            alt="${widget.imageAlt}"
          />

          <header class="widget-block-header">
            <h2 class="widget-block-title">
              ${widget.title}
            </h2>
          </header>

          <div class="widget-block-excerpt">
            ${widget.description}
          </div>

          <div class="widget-block-links">
            <a href="${widget.buttonUrl}" class="btn btn-block btn-primary">
              ${widget.buttonText}&nbsp;&nbsp;
              <span class="fa fa-lg fa-sign-in"></span>
            </a>
          </div>

        </div>
      </div>
    </div>
  `;
}

function moreServices(widget) {
  return `
    <div class="col-12 col-lg-4 col-xl-4 mb-4">
      <a href="${widget.buttonUrl}" class="not-featured">
        <img
          src="${widget.image}"
          alt="${widget.imageAlt}"
          style="height:48px; width:48px"
        >

        <div>
          <h3 class="my-1" style="font-size: 16px; font-weight: 600">
            ${widget.title}
          </h3>
          <p>${widget.description}</p>
        </div>

        <img
          src="images/rightArrow.png"
          alt="right arrow"
          style="height: 24px; width: 24px"
        >
      </a>
    </div>
  `;
}

const featuredWidgets = widgets.filter(widget => widget.feature === true);
const moreServiceWidgets = widgets.filter(widget => widget.feature === false);

quickAccessContainer.innerHTML = featuredWidgets.map(quickAccess).join("");
moreServicesContainer.innerHTML = moreServiceWidgets.map(moreServices).join("");
