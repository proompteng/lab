Rails.application.routes.draw do
  # Define your application routes per the DSL in https://guides.rubyonrails.org/routing.html

  get "health" => "health#show", as: :health
  get "up" => "rails/health#show", as: :rails_health_check

  root "home#index"
end
